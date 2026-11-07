package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"

	"github.com/m4rtins/forja/agent/internal/cloudflare"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const maxCFDomains = 200

type CFRoutesSync struct {
	CF cloudflare.Client
}

type CFRoutesSyncParams struct {
	ConnectionID int      `json:"connection_id"`
	CFAccountID  string   `json:"cf_account_id"`
	TunnelID     string   `json:"tunnel_id"`
	APIToken     string   `json:"api_token"`
	Domains      []string `json:"domains"`
}

// CFDomainResult carries a fixed error code, never Cloudflare's own message
// (those may include zone ids and API paths); the detail goes to the agent log.
type CFDomainResult struct {
	Hostname string `json:"hostname"`
	Status   string `json:"status"`         // "ok" or "error"
	Code     string `json:"code,omitempty"` // ZONE_NOT_FOUND, DNS_CONFLICT or CF_ERROR
}

type CFRoutesSyncResult struct {
	Domains []CFDomainResult `json:"domains"`
	Failed  int              `json:"failed"`
}

func (a *CFRoutesSync) Name() string { return "cf.routes.sync" }

func (a *CFRoutesSync) Validate(params json.RawMessage) error {
	var p CFRoutesSyncParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validConnectionID(p.ConnectionID); err != nil {
		return err
	}
	if err := validate.CFAccountID(p.CFAccountID); err != nil {
		return err
	}
	if err := validate.TunnelID(p.TunnelID); err != nil {
		return err
	}
	if err := validate.CFAPIToken(p.APIToken); err != nil {
		return err
	}
	if len(p.Domains) > maxCFDomains {
		return fmt.Errorf("%w: too many domains (max %d)", validate.ErrInvalid, maxCFDomains)
	}
	seen := make(map[string]bool, len(p.Domains))
	for _, d := range p.Domains {
		if err := validate.Hostname(d); err != nil {
			return err
		}
		if seen[d] {
			return fmt.Errorf("%w: duplicate domain %q", validate.ErrInvalid, d)
		}
		seen[d] = true
	}
	return nil
}

func (a *CFRoutesSync) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p CFRoutesSyncParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	result := &CFRoutesSyncResult{Domains: make([]CFDomainResult, 0, len(p.Domains))}
	zones := make(map[string]string, len(p.Domains))
	var routable []string

	// 1. Resolve zones. A domain outside the token's zones is reported but
	//    must not block the rest.
	for _, d := range p.Domains {
		zoneID, err := a.CF.FindZoneID(ctx, p.APIToken, d)
		if err != nil {
			if errors.Is(err, cloudflare.ErrZoneNotFound) {
				result.Domains = append(result.Domains, CFDomainResult{Hostname: d, Status: "error", Code: "ZONE_NOT_FOUND"})
				result.Failed++
				continue
			}
			return nil, fmt.Errorf("zone lookup for %s: %w", d, err)
		}
		zones[d] = zoneID
		routable = append(routable, d)
	}

	// 2. Replace the tunnel ingress (also with an empty list: catch-all only).
	if err := a.CF.PutTunnelIngress(ctx, p.APIToken, p.CFAccountID, p.TunnelID, routable, cfIngressService); err != nil {
		return nil, fmt.Errorf("update tunnel ingress: %w", err)
	}

	// 3. CNAME per domain. Only upserts: records are never deleted here.
	for _, d := range routable {
		if err := a.CF.UpsertTunnelCNAME(ctx, p.APIToken, zones[d], d, p.TunnelID); err != nil {
			code := "CF_ERROR"
			if errors.Is(err, cloudflare.ErrDNSConflict) {
				code = "DNS_CONFLICT"
			}
			slog.Warn("cf.routes.sync: dns upsert failed", "domain", d, "code", code, "error", err)
			result.Domains = append(result.Domains, CFDomainResult{Hostname: d, Status: "error", Code: code})
			result.Failed++
			continue
		}
		result.Domains = append(result.Domains, CFDomainResult{Hostname: d, Status: "ok"})
	}

	return result, nil
}
