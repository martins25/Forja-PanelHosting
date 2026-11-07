package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/caddy"
)

func onlineSite() CaddySiteEntry {
	return CaddySiteEntry{
		Domains:      []string{"mysite.com"},
		Mode:         "online",
		InternalPort: 10000,
		AccountSlug:  "demo",
	}
}

func TestCaddySync_Name(t *testing.T) {
	a := &CaddySync{Caddy: &caddy.FakeClient{}}
	if a.Name() != "caddy.sync" {
		t.Errorf("expected caddy.sync, got %s", a.Name())
	}
}

func TestCaddySync_Validate_OK(t *testing.T) {
	a := &CaddySync{Caddy: &caddy.FakeClient{}}
	params, _ := json.Marshal(CaddySyncParams{
		Sites: []CaddySiteEntry{onlineSite()},
	})
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestCaddySync_Validate_EmptySites(t *testing.T) {
	a := &CaddySync{Caddy: &caddy.FakeClient{}}
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{}})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty sites")
	}
}

func TestCaddySync_Validate_InvalidMode(t *testing.T) {
	a := &CaddySync{Caddy: &caddy.FakeClient{}}
	s := onlineSite()
	s.Mode = "broken"
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{s}})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid mode")
	}
}

func TestCaddySync_Execute_OnlineSite(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}
	params, _ := json.Marshal(CaddySyncParams{
		Sites: []CaddySiteEntry{onlineSite()},
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*CaddySyncResult)
	if r.RoutesLoaded != 1 {
		t.Errorf("expected 1 route, got %d", r.RoutesLoaded)
	}

	if len(fc.Calls) != 1 {
		t.Fatalf("expected 1 caddy call, got %d", len(fc.Calls))
	}

	configStr := string(fc.Calls[0])
	if !strings.Contains(configStr, "reverse_proxy") {
		t.Error("expected reverse_proxy in config")
	}
	if !strings.Contains(configStr, "127.0.0.1:10000") {
		t.Error("expected port 10000 in config")
	}
	if !strings.Contains(configStr, "mysite.com") {
		t.Error("expected domain in config")
	}
}

func TestCaddySync_Execute_MaintenanceSite(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}

	s := onlineSite()
	s.Mode = "maintenance"
	s.NoticeTitle = "En obras"
	s.NoticeMsg = "Volvemos pronto"
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{s}})

	if _, err := a.Execute(context.Background(), params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	configStr := string(fc.Calls[0])
	if !strings.Contains(configStr, "static_response") {
		t.Error("expected static_response for maintenance")
	}
	if !strings.Contains(configStr, "503") {
		t.Error("expected 503 status for maintenance")
	}
	if !strings.Contains(configStr, "Retry-After") {
		t.Error("expected Retry-After header")
	}
}

func TestCaddySync_Execute_DisabledSite(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}

	s := onlineSite()
	s.Mode = "disabled"
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{s}})

	if _, err := a.Execute(context.Background(), params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	configStr := string(fc.Calls[0])
	if !strings.Contains(configStr, "403") {
		t.Error("expected 403 status for disabled")
	}
}

func TestCaddySync_Execute_MultipleSites(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}

	s1 := onlineSite()
	s2 := CaddySiteEntry{
		Domains:      []string{"other.com"},
		Mode:         "online",
		InternalPort: 10002,
		AccountSlug:  "other",
	}
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{s1, s2}})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.(*CaddySyncResult).RoutesLoaded != 2 {
		t.Error("expected 2 routes")
	}

	configStr := string(fc.Calls[0])
	if !strings.Contains(configStr, "mysite.com") || !strings.Contains(configStr, "other.com") {
		t.Error("expected both domains in config")
	}
}

func TestCaddySync_Execute_WithPanel(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}

	params, _ := json.Marshal(CaddySyncParams{
		Sites:     []CaddySiteEntry{onlineSite()},
		PanelPort: 7000,
	})

	if _, err := a.Execute(context.Background(), params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	configStr := string(fc.Calls[0])
	if !strings.Contains(configStr, "127.0.0.1:7000") {
		t.Error("expected panel route in config")
	}
}

func TestCaddySync_Execute_CaddyError(t *testing.T) {
	fc := &caddy.FakeClient{LoadErr: fmt.Errorf("caddy refused")}
	a := &CaddySync{Caddy: fc}

	params, _ := json.Marshal(CaddySyncParams{
		Sites: []CaddySiteEntry{onlineSite()},
	})

	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when caddy rejects config")
	}
	if !strings.Contains(err.Error(), "caddy load failed") {
		t.Errorf("expected caddy error, got: %v", err)
	}
}

func TestBuildCaddyConfig_LogPaths(t *testing.T) {
	s := onlineSite()
	cfg := buildCaddyConfig(CaddySyncParams{Sites: []CaddySiteEntry{s}})

	data, _ := json.Marshal(cfg)
	configStr := string(data)
	if !strings.Contains(configStr, "/srv/forja/accounts/demo/logs/access.log") {
		t.Error("expected log path in demo account dir")
	}
}

func TestBuildCaddyConfig_Structure(t *testing.T) {
	s := onlineSite()
	cfg := buildCaddyConfig(CaddySyncParams{Sites: []CaddySiteEntry{s}})

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}

	apps, ok := parsed["apps"].(map[string]any)
	if !ok {
		t.Fatal("expected apps key")
	}
	httpApp, ok := apps["http"].(map[string]any)
	if !ok {
		t.Fatal("expected http key")
	}
	servers, ok := httpApp["servers"].(map[string]any)
	if !ok {
		t.Fatal("expected servers key")
	}
	if _, ok := servers["forja"]; !ok {
		t.Fatal("expected forja server")
	}
}

func TestCaddySync_Execute_PanelOnlyOnLoopbackServer(t *testing.T) {
	fc := &caddy.FakeClient{}
	a := &CaddySync{Caddy: fc}
	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{onlineSite()}, PanelPort: 7000})

	if _, err := a.Execute(context.Background(), params); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var cfg struct {
		Apps struct {
			HTTP struct {
				Servers map[string]struct {
					Listen []string `json:"listen"`
					Routes []struct {
						Match []struct {
							Host []string `json:"host"`
						} `json:"match"`
					} `json:"routes"`
				} `json:"servers"`
			} `json:"http"`
		} `json:"apps"`
	}
	if err := json.Unmarshal(fc.Calls[0], &cfg); err != nil {
		t.Fatal(err)
	}
	servers := cfg.Apps.HTTP.Servers

	loop, ing := servers["forja"], servers["forja-ingress"]
	if len(loop.Listen) != 1 || loop.Listen[0] != "127.0.0.1:80" {
		t.Errorf("loopback server listen = %v", loop.Listen)
	}
	if len(ing.Listen) != 1 || ing.Listen[0] != "10.255.0.1:80" {
		t.Errorf("ingress server listen = %v (never a wildcard address)", ing.Listen)
	}

	hasHost := func(routes []struct {
		Match []struct {
			Host []string `json:"host"`
		} `json:"match"`
	}, host string) bool {
		for _, r := range routes {
			for _, m := range r.Match {
				for _, h := range m.Host {
					if h == host {
						return true
					}
				}
			}
		}
		return false
	}
	if !hasHost(loop.Routes, "panel.localhost") {
		t.Error("loopback server must carry the panel route")
	}
	if hasHost(ing.Routes, "panel.localhost") {
		t.Error("ingress server must NOT route the panel (reachable from account containers)")
	}
	if !hasHost(ing.Routes, "mysite.com") || !hasHost(loop.Routes, "mysite.com") {
		t.Error("both servers must serve the sites")
	}
}

func TestNoticePages_EscapeHTML(t *testing.T) {
	payload := `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`
	for name, fn := range map[string]func(string, string) string{
		"maintenance": maintenancePage,
		"disabled":    disabledPage,
	} {
		out := fn(payload, payload)
		if strings.Contains(out, "<script>") || strings.Contains(out, "<img") {
			t.Errorf("%s: unescaped HTML in output: %s", name, out)
		}
		if !strings.Contains(out, "&lt;script&gt;") {
			t.Errorf("%s: expected escaped script tag, got: %s", name, out)
		}
	}
}

func TestNoticePages_NeutralizeCaddyPlaceholders(t *testing.T) {
	out := maintenancePage("{env.SECRET}", "{http.request.header.Cookie}")
	if strings.Contains(out, "{") || strings.Contains(out, "}") {
		t.Errorf("curly braces must be entity-encoded, got: %s", out)
	}
}

func TestCaddySync_Execute_NoticeSitesXSSAndCSP(t *testing.T) {
	for _, mode := range []string{"maintenance", "disabled"} {
		fc := &caddy.FakeClient{}
		a := &CaddySync{Caddy: fc}
		s := onlineSite()
		s.Mode = mode
		s.NoticeTitle = "<script>alert(1)</script>"
		s.NoticeMsg = "<img src=x onerror=alert(1)>"
		params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{s}})
		if _, err := a.Execute(context.Background(), params); err != nil {
			t.Fatalf("%s: unexpected error: %v", mode, err)
		}
		cfg := string(fc.Calls[0])
		// json.Marshal escapes < and > as \u003c/\u003e, so look for the
		// decoded form too.
		var decoded any
		if err := json.Unmarshal(fc.Calls[0], &decoded); err != nil {
			t.Fatal(err)
		}
		flat, _ := json.Marshal(decoded)
		if strings.Contains(cfg, "<script>") || strings.Contains(string(flat), "<script>") {
			t.Errorf("%s: raw <script> reached the Caddy config", mode)
		}
		if !strings.Contains(cfg, "Content-Security-Policy") {
			t.Errorf("%s: expected CSP header on static notice page", mode)
		}
		if !strings.Contains(cfg, "frame-ancestors 'none'") {
			t.Errorf("%s: CSP must forbid framing", mode)
		}
		if !strings.Contains(cfg, "text/html; charset=utf-8") {
			t.Errorf("%s: expected explicit content type", mode)
		}
	}
}

func TestBuildCaddyConfig_SecurityHeadersOnEveryRoute(t *testing.T) {
	dis := onlineSite()
	dis.Mode = "disabled"
	maint := onlineSite()
	maint.Mode = "maintenance"
	cfg := buildCaddyConfig(CaddySyncParams{
		PanelPort: 4000,
		Sites:     []CaddySiteEntry{onlineSite(), dis, maint},
	})

	for name, srv := range cfg.Apps.HTTP.Servers {
		for i, route := range srv.Routes {
			var found bool
			for _, h := range route.Handle {
				if h.Handler != "headers" || h.Response == nil {
					continue
				}
				set := h.Response.Set
				_, csp := set["Content-Security-Policy"]
				_, cspDefault := set["?Content-Security-Policy"]
				_, xfo := set["X-Frame-Options"]
				_, xfoDefault := set["?X-Frame-Options"]
				_, rp := set["Referrer-Policy"]
				_, rpDefault := set["?Referrer-Policy"]
				if (csp || cspDefault) && (xfo || xfoDefault) && (rp || rpDefault) {
					found = true
				}
			}
			if !found {
				t.Errorf("server %s route %d lacks security headers", name, i)
			}
		}
	}
}

func TestDefaultSecurityHeaders_DeferredAndNonOverriding(t *testing.T) {
	h := defaultSecurityHeaders()
	if !h.Response.Deferred {
		t.Error("headers must be deferred so they apply after the upstream response")
	}
	for k := range h.Response.Set {
		if !strings.HasPrefix(k, "?") {
			t.Errorf("%s must be default-if-absent (? prefix) so apps keep their own policy", k)
		}
	}
}
