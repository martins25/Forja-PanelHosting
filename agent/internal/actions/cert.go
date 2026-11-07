package actions

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/m4rtins/forja/agent/internal/caddy"
	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const (
	// certBase is root-owned and outside every account home.
	certBase       = "/srv/forja/certs"
	certTokenDir   = certBase + "/tokens"
	certStateFile  = certBase + "/state.json"
	caddyUser      = "caddy"
	caddyTLSPath   = "apps/tls"
	certStatePerm  = 0o600
	certTokenPerm  = 0o640
	certDirPerm    = 0o750
	maxManagedCert = 1000

	// Where Caddy (running as the "caddy" user) keeps issued certificates.
	caddyCertStorage = "/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory"

	CertStatusPending = "pending"
	CertStatusActive  = "active"
	CertStatusExpired = "expired"
)

// certStateMu serialises read-modify-write cycles on the state file.
var certStateMu sync.Mutex

type certEntry struct {
	Domain      string `json:"domain"`
	AccountSlug string `json:"account_slug"`
}

type certState struct {
	Certs []certEntry `json:"certs"`
}

func loadCertState(os_ osutil.OSExecutor) (*certState, error) {
	data, err := os_.ReadFile(certStateFile)
	if errors.Is(err, os.ErrNotExist) {
		return &certState{}, nil
	}
	if err != nil {
		return nil, err
	}
	var st certState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("corrupt certificate state: %w", err)
	}
	return &st, nil
}

func saveCertState(os_ osutil.OSExecutor, st *certState) error {
	sort.Slice(st.Certs, func(i, j int) bool { return st.Certs[i].Domain < st.Certs[j].Domain })
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return os_.WriteFileAtomic(certStateFile, data, certStatePerm, 0, 0)
}

func certTokenPath(slug string) string {
	return filepath.Join(certTokenDir, slug+".token")
}

// Caddy JSON for the TLS app. The Cloudflare token never goes into the config:
// the DNS provider reads it through Caddy's {file.*} placeholder, so the token
// does not end up in the admin API output or in Caddy's autosave.
type caddyTLS struct {
	Automation   caddyTLSAutomation   `json:"automation"`
	Certificates caddyTLSCertificates `json:"certificates"`
}

type caddyTLSAutomation struct {
	Policies []caddyTLSPolicy `json:"policies"`
}

type caddyTLSPolicy struct {
	Subjects []string         `json:"subjects"`
	Issuers  []map[string]any `json:"issuers"`
}

type caddyTLSCertificates struct {
	Automate []string `json:"automate"`
}

// buildTLSApp returns nil when no certificate is managed.
func buildTLSApp(st *certState) *caddyTLS {
	if st == nil || len(st.Certs) == 0 {
		return nil
	}
	bySlug := map[string][]string{}
	var all []string
	for _, c := range st.Certs {
		bySlug[c.AccountSlug] = append(bySlug[c.AccountSlug], c.Domain)
		all = append(all, c.Domain)
	}
	slugs := make([]string, 0, len(bySlug))
	for s := range bySlug {
		slugs = append(slugs, s)
	}
	sort.Strings(slugs)
	sort.Strings(all)

	tls := &caddyTLS{Certificates: caddyTLSCertificates{Automate: all}}
	for _, slug := range slugs {
		domains := bySlug[slug]
		sort.Strings(domains)
		tls.Automation.Policies = append(tls.Automation.Policies, caddyTLSPolicy{
			Subjects: domains,
			Issuers: []map[string]any{{
				"module": "acme",
				"challenges": map[string]any{
					"dns": map[string]any{
						"provider": map[string]any{
							"name":      "cloudflare",
							"api_token": "{file." + certTokenPath(slug) + "}",
						},
					},
				},
			}},
		})
	}
	return tls
}

type CertResult struct {
	Domain    string `json:"domain"`
	Status    string `json:"status"`
	IssuedAt  string `json:"issued_at,omitempty"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

// readCertStatus reads the certificate Caddy stored for a domain. A missing
// file means issuance has not finished (or failed): "pending".
func readCertStatus(os_ osutil.OSExecutor, domain string, now time.Time) (*CertResult, error) {
	res := &CertResult{Domain: domain, Status: CertStatusPending}
	data, err := os_.ReadFile(filepath.Join(caddyCertStorage, domain, domain+".crt"))
	if errors.Is(err, os.ErrNotExist) {
		return res, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read certificate: %w", err)
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return res, nil
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return res, nil
	}
	res.IssuedAt = cert.NotBefore.UTC().Format(time.RFC3339)
	res.ExpiresAt = cert.NotAfter.UTC().Format(time.RFC3339)
	if now.After(cert.NotAfter) {
		res.Status = CertStatusExpired
	} else {
		res.Status = CertStatusActive
	}
	return res, nil
}

type CertParams struct {
	AccountSlug string `json:"account_slug"`
	Domain      string `json:"domain"`
	CFAPIToken  string `json:"cf_api_token"`
}

func validateCertParams(params json.RawMessage) (*CertParams, error) {
	var p CertParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return nil, err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return nil, err
	}
	if err := validate.CFAPIToken(p.CFAPIToken); err != nil {
		return nil, err
	}
	return &p, nil
}

// applyCert registers the domain, writes the token file and pushes the TLS app to
// Caddy. Shared by cert.request and cert.renew.
func applyCert(ctx context.Context, os_ osutil.OSExecutor, cd caddy.Client, p *CertParams, requireExisting bool) (any, error) {
	if _, _, err := os_.LookupUser(linuxUserPfx + p.AccountSlug); err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}
	_, caddyGID, err := os_.LookupUser(caddyUser)
	if err != nil {
		return nil, fmt.Errorf("caddy user not found: %w", err)
	}

	certStateMu.Lock()
	defer certStateMu.Unlock()

	st, err := loadCertState(os_)
	if err != nil {
		return nil, fmt.Errorf("read certificate state: %w", err)
	}
	known := false
	for _, c := range st.Certs {
		if c.Domain != p.Domain {
			continue
		}
		if c.AccountSlug != p.AccountSlug {
			return nil, fmt.Errorf("%w: domain is managed by another account", validate.ErrInvalid)
		}
		known = true
	}
	if requireExisting && !known {
		return nil, fmt.Errorf("%w: no certificate was requested for this domain", validate.ErrInvalid)
	}
	if !known {
		if len(st.Certs) >= maxManagedCert {
			return nil, fmt.Errorf("%w: too many managed certificates", validate.ErrInvalid)
		}
		st.Certs = append(st.Certs, certEntry{Domain: p.Domain, AccountSlug: p.AccountSlug})
	}

	// Root-owned directories, readable by Caddy only through its group.
	if err := os_.EnsureDir(certBase, certDirPerm, 0, caddyGID); err != nil {
		return nil, fmt.Errorf("prepare %s: %w", certBase, err)
	}
	if err := os_.EnsureDir(certTokenDir, certDirPerm, 0, caddyGID); err != nil {
		return nil, fmt.Errorf("prepare %s: %w", certTokenDir, err)
	}
	// No trailing newline: the token is read verbatim by {file.*}.
	if err := os_.WriteFileAtomic(certTokenPath(p.AccountSlug), []byte(p.CFAPIToken), certTokenPerm, 0, caddyGID); err != nil {
		return nil, fmt.Errorf("write token file: %w", err)
	}
	if err := saveCertState(os_, st); err != nil {
		return nil, fmt.Errorf("write certificate state: %w", err)
	}

	tlsJSON, err := json.Marshal(buildTLSApp(st))
	if err != nil {
		return nil, fmt.Errorf("marshal tls config: %w", err)
	}
	if err := cd.SetConfig(ctx, caddyTLSPath, tlsJSON); err != nil {
		return nil, fmt.Errorf("caddy tls config failed: %w", err)
	}

	return readCertStatus(os_, p.Domain, time.Now())
}

// CertRequest asks Caddy to obtain and keep renewed a Let's Encrypt certificate
// for a domain using the DNS-01 challenge through the account's Cloudflare token.
type CertRequest struct {
	OS    osutil.OSExecutor
	Caddy caddy.Client
}

func (a *CertRequest) Name() string { return "cert.request" }

func (a *CertRequest) Validate(params json.RawMessage) error {
	_, err := validateCertParams(params)
	return err
}

func (a *CertRequest) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := validateCertParams(params)
	if err != nil {
		return nil, err
	}
	return applyCert(ctx, a.OS, a.Caddy, p, false)
}

// CertRenew refreshes the token (it may have been rotated), re-applies the TLS
// config and reports the certificate state. Caddy performs the renewal itself
// inside the renewal window; the action never deletes certificate files.
type CertRenew struct {
	OS    osutil.OSExecutor
	Caddy caddy.Client
}

func (a *CertRenew) Name() string { return "cert.renew" }

func (a *CertRenew) Validate(params json.RawMessage) error {
	_, err := validateCertParams(params)
	return err
}

func (a *CertRenew) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := validateCertParams(params)
	if err != nil {
		return nil, err
	}
	return applyCert(ctx, a.OS, a.Caddy, p, true)
}

// CertStatus reports the stored certificate of a managed domain (read-only).
type CertStatus struct {
	OS osutil.OSExecutor
}

type CertStatusParams struct {
	AccountSlug string `json:"account_slug"`
	Domain      string `json:"domain"`
}

func (a *CertStatus) Name() string { return "cert.status" }

func parseStatusParams(params json.RawMessage) (*CertStatusParams, error) {
	var p CertStatusParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return nil, err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return nil, err
	}
	return &p, nil
}

func (a *CertStatus) Validate(params json.RawMessage) error {
	_, err := parseStatusParams(params)
	return err
}

func (a *CertStatus) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	p, err := parseStatusParams(params)
	if err != nil {
		return nil, err
	}
	st, err := loadCertState(a.OS)
	if err != nil {
		return nil, fmt.Errorf("read certificate state: %w", err)
	}
	for _, c := range st.Certs {
		if c.Domain == p.Domain && c.AccountSlug == p.AccountSlug {
			return readCertStatus(a.OS, p.Domain, time.Now())
		}
	}
	return nil, fmt.Errorf("%w: no certificate was requested for this domain", validate.ErrInvalid)
}
