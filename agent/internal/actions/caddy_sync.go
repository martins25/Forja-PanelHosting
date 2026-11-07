package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"html/template"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/caddy"
	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type CaddySync struct {
	Caddy caddy.Client
	// OS is used to read the certificate state so that a full reload keeps the
	// TLS automation policies. Optional: without it no TLS app is emitted.
	OS osutil.OSExecutor
}

type CaddySiteEntry struct {
	Domains      []string `json:"domains"`
	Mode         string   `json:"mode"`
	InternalPort int      `json:"internal_port"`
	AccountSlug  string   `json:"account_slug"`
	NoticeTitle  string   `json:"notice_title"`
	NoticeMsg    string   `json:"notice_message"`
}

type CaddySyncParams struct {
	Sites     []CaddySiteEntry `json:"sites"`
	PanelPort int              `json:"panel_port"`
}

type CaddySyncResult struct {
	RoutesLoaded int `json:"routes_loaded"`
}

func (a *CaddySync) Name() string { return "caddy.sync" }

func (a *CaddySync) Validate(params json.RawMessage) error {
	var p CaddySyncParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if len(p.Sites) == 0 {
		return fmt.Errorf("%w: sites list is empty", validate.ErrInvalid)
	}
	for i, s := range p.Sites {
		if len(s.Domains) == 0 {
			return fmt.Errorf("%w: site %d has no domains", validate.ErrInvalid, i)
		}
		for _, d := range s.Domains {
			if err := validate.Hostname(d); err != nil {
				return err
			}
		}
		switch s.Mode {
		case "online", "maintenance", "disabled":
		default:
			return fmt.Errorf("%w: invalid mode %q for site %d", validate.ErrInvalid, s.Mode, i)
		}
		if s.Mode == "online" {
			if err := validate.Port(s.InternalPort); err != nil {
				return err
			}
		}
		if err := validate.Slug(s.AccountSlug); err != nil {
			return err
		}
	}
	return nil
}

func (a *CaddySync) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p CaddySyncParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	config := buildCaddyConfig(p)
	if a.OS != nil {
		state, err := loadCertState(a.OS)
		if err != nil {
			return nil, fmt.Errorf("read certificate state: %w", err)
		}
		config.Apps.TLS = buildTLSApp(state)
	}
	configJSON, err := json.Marshal(config)
	if err != nil {
		return nil, fmt.Errorf("marshal caddy config: %w", err)
	}

	if err := a.Caddy.LoadConfig(ctx, configJSON); err != nil {
		return nil, fmt.Errorf("caddy load failed: %w", err)
	}

	return &CaddySyncResult{RoutesLoaded: len(p.Sites)}, nil
}

type caddyConfig struct {
	Apps caddyApps `json:"apps"`
}

type caddyApps struct {
	HTTP    caddyHTTP    `json:"http"`
	Logging caddyLogging `json:"logging"`
	TLS     *caddyTLS    `json:"tls,omitempty"`
}

type caddyHTTP struct {
	Servers map[string]caddyServer `json:"servers"`
}

type caddyServer struct {
	Listen []string     `json:"listen"`
	Routes []caddyRoute `json:"routes"`
	Logs   *caddyLogs   `json:"logs,omitempty"`
}

type caddyLogs struct {
	LoggerNames map[string]string `json:"logger_names,omitempty"`
}

type caddyRoute struct {
	Match    []caddyMatch   `json:"match"`
	Handle   []caddyHandler `json:"handle"`
	Terminal bool           `json:"terminal"`
}

type caddyMatch struct {
	Host []string `json:"host"`
}

type caddyHandler struct {
	Handler      string             `json:"handler"`
	Upstreams    []caddyUpstream    `json:"upstreams,omitempty"`
	HealthChecks *caddyHealthChecks `json:"health_checks,omitempty"`
	StatusCode   string             `json:"status_code,omitempty"`
	Body         string             `json:"body,omitempty"`
	Response     *caddyHeaderResp   `json:"response,omitempty"`
}

type caddyUpstream struct {
	Dial string `json:"dial"`
}

type caddyHealthChecks struct {
	Passive *caddyPassiveHealth `json:"passive,omitempty"`
}

type caddyPassiveHealth struct {
	FailDuration string `json:"fail_duration"`
	MaxFails     int    `json:"max_fails"`
}

type caddyHeaderResp struct {
	Set map[string][]string `json:"set"`
	// Deferred applies the operations when the response is written, i.e. after
	// the upstream (reverse_proxy) has set its own headers.
	Deferred bool `json:"deferred,omitempty"`
}

type caddyLogging struct {
	Logs map[string]caddyLogEntry `json:"logs"`
}

type caddyLogEntry struct {
	Writer  caddyLogWriter  `json:"writer"`
	Encoder caddyLogEncoder `json:"encoder"`
	Include []string        `json:"include"`
}

type caddyLogWriter struct {
	Output     string `json:"output"`
	Filename   string `json:"filename"`
	RollSizeMB int    `json:"roll_size_mb"`
	RollKeep   int    `json:"roll_keep"`
}

type caddyLogEncoder struct {
	Format string `json:"format"`
}

func buildCaddyConfig(p CaddySyncParams) caddyConfig {
	var routes []caddyRoute
	loggerNames := make(map[string]string)
	logEntries := make(map[string]caddyLogEntry)

	var panelRoutes []caddyRoute
	if p.PanelPort > 0 {
		panelRoutes = append(panelRoutes, caddyRoute{
			Match: []caddyMatch{{Host: []string{"panel.localhost"}}},
			Handle: []caddyHandler{
				defaultSecurityHeaders(),
				{
					Handler:   "reverse_proxy",
					Upstreams: []caddyUpstream{{Dial: fmt.Sprintf("127.0.0.1:%d", p.PanelPort)}},
				},
			},
			Terminal: true,
		})
	}

	for _, site := range p.Sites {
		route := caddyRoute{
			Match:    []caddyMatch{{Host: site.Domains}},
			Terminal: true,
		}

		switch site.Mode {
		case "online":
			route.Handle = []caddyHandler{
				defaultSecurityHeaders(),
				{
					Handler:   "reverse_proxy",
					Upstreams: []caddyUpstream{{Dial: fmt.Sprintf("127.0.0.1:%d", site.InternalPort)}},
					HealthChecks: &caddyHealthChecks{
						Passive: &caddyPassiveHealth{
							FailDuration: "30s",
							MaxFails:     3,
						},
					},
				},
			}

			domSafe := validate.DomainSafe(site.Domains[0])
			loggerName := fmt.Sprintf("site-%s-%s", site.AccountSlug, domSafe)
			loggerNames[site.Domains[0]] = loggerName
			logEntries[loggerName] = caddyLogEntry{
				Writer: caddyLogWriter{
					Output:     "file",
					Filename:   filepath.Join(accountsBase, site.AccountSlug, "logs", "access.log"),
					RollSizeMB: 10,
					RollKeep:   3,
				},
				Encoder: caddyLogEncoder{Format: "json"},
				Include: []string{fmt.Sprintf("http.log.access.%s", loggerName)},
			}

		case "maintenance":
			route.Handle = []caddyHandler{
				noticeHeaders(map[string][]string{"Retry-After": {"3600"}}),
				{
					Handler:    "static_response",
					StatusCode: "503",
					Body:       maintenancePage(site.NoticeTitle, site.NoticeMsg),
				},
			}

		case "disabled":
			route.Handle = []caddyHandler{
				noticeHeaders(nil),
				{
					Handler:    "static_response",
					StatusCode: "403",
					Body:       disabledPage(site.NoticeTitle, site.NoticeMsg),
				},
			}
		}

		routes = append(routes, route)
	}

	return caddyConfig{
		Apps: caddyApps{
			HTTP: caddyHTTP{
				Servers: map[string]caddyServer{
					// Loopback: reached by Caddy's own tunnel and the panel; carries the panel route.
					"forja": {
						Listen: []string{"127.0.0.1:80"},
						Routes: append(append([]caddyRoute{}, panelRoutes...), routes...),
						Logs:   &caddyLogs{LoggerNames: loggerNames},
					},
					// Ingress address: reachable from account containers (cloudflared), so
					// it serves sites only and never the panel.
					"forja-ingress": {
						Listen: []string{ForjaIngressAddr + ":80"},
						Routes: routes,
						Logs:   &caddyLogs{LoggerNames: loggerNames},
					},
				},
			},
			Logging: caddyLogging{Logs: logEntries},
		},
	}
}

// noticeCSP locks the static notice pages down: no scripts, no framing, no
// external resources. Inline styles are not needed by the templates either.
const noticeCSP = "default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// defaultSecurityHeaders adds baseline security headers to proxied responses.
// The "?" prefix makes Caddy set a header only when the upstream did not set it
// (and deferred runs the operation after the upstream responded), so apps that
// ship their own CSP or framing policy keep it, and everything else gets a
// safe default.
func defaultSecurityHeaders() caddyHandler {
	return caddyHandler{
		Handler: "headers",
		Response: &caddyHeaderResp{
			Deferred: true,
			Set: map[string][]string{
				"?Content-Security-Policy": {"frame-ancestors 'self'"},
				"?X-Frame-Options":         {"SAMEORIGIN"},
				"?X-Content-Type-Options":  {"nosniff"},
				"?Referrer-Policy":         {"strict-origin-when-cross-origin"},
			},
		},
	}
}

// noticeHeaders returns the headers handler for static notice pages
// (maintenance/disabled), including a restrictive CSP.
func noticeHeaders(extra map[string][]string) caddyHandler {
	set := map[string][]string{
		"Content-Type":            {"text/html; charset=utf-8"},
		"Content-Security-Policy": {noticeCSP},
		"X-Content-Type-Options":  {"nosniff"},
		"X-Frame-Options":         {"DENY"},
		"Referrer-Policy":         {"no-referrer"},
	}
	for k, v := range extra {
		set[k] = v
	}
	return caddyHandler{Handler: "headers", Response: &caddyHeaderResp{Set: set}}
}

// escapeNotice HTML-escapes user-controlled notice text. Curly braces are also
// emitted as character entities because Caddy expands {placeholders} (e.g.
// {env.X}) in static_response bodies.
func escapeNotice(s string) string {
	s = template.HTMLEscapeString(s)
	s = strings.ReplaceAll(s, "{", "&#123;")
	s = strings.ReplaceAll(s, "}", "&#125;")
	return s
}

func noticePage(title, msg string) string {
	t, m := escapeNotice(title), escapeNotice(msg)
	return fmt.Sprintf("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>", t, t, m)
}

func maintenancePage(title, msg string) string {
	if title == "" {
		title = "Mantenimiento"
	}
	if msg == "" {
		msg = "El sitio esta en mantenimiento. Vuelve pronto."
	}
	return noticePage(title, msg)
}

func disabledPage(title, msg string) string {
	if title == "" {
		title = "Sitio deshabilitado"
	}
	if msg == "" {
		msg = "Este sitio ha sido deshabilitado."
	}
	return noticePage(title, msg)
}
