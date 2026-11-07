// Package cloudflare is a minimal client for the parts of the Cloudflare API
// that Forja needs: zone lookup, tunnel ingress configuration and CNAME records.
package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	DefaultBaseURL = "https://api.cloudflare.com/client/v4"
	maxResponse    = 1 << 20
)

var (
	ErrZoneNotFound = errors.New("cloudflare: zone not found")
	ErrDNSConflict  = errors.New("cloudflare: a conflicting DNS record already exists")
	// ErrForeignIngress means the tunnel already routes hostnames to services
	// that Forja did not configure; replacing its ingress would break them.
	ErrForeignIngress = errors.New("cloudflare: tunnel has ingress rules not managed by Forja")
)

// Client is the subset of the Cloudflare API used by the cf.* actions.
type Client interface {
	// FindZoneID returns the zone that contains hostname (longest suffix match).
	FindZoneID(ctx context.Context, token, hostname string) (string, error)
	// PutTunnelIngress replaces the whole ingress configuration of a tunnel:
	// one rule per hostname towards service, plus a catch-all 404. It refuses
	// (ErrForeignIngress) when the current configuration routes to any other service.
	PutTunnelIngress(ctx context.Context, token, accountID, tunnelID string, hostnames []string, service string) error
	// UpsertTunnelCNAME creates or updates a proxied CNAME to the tunnel.
	UpsertTunnelCNAME(ctx context.Context, token, zoneID, hostname, tunnelID string) error
}

type RealClient struct {
	BaseURL string
	HTTP    *http.Client
}

func NewClient() *RealClient {
	return &RealClient{
		BaseURL: DefaultBaseURL,
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}
}

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type envelope struct {
	Success bool            `json:"success"`
	Errors  []apiError      `json:"errors"`
	Result  json.RawMessage `json:"result"`
}

// do performs an authenticated request. The token is only ever sent in the
// Authorization header and never included in returned errors.
func (c *RealClient) do(ctx context.Context, token, method, path string, body any) (json.RawMessage, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("cloudflare: marshal body: %w", err)
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return nil, fmt.Errorf("cloudflare: build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTP.Do(req)
	if err != nil {
		// url.Error carries only method and URL, never headers.
		return nil, fmt.Errorf("cloudflare: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return nil, fmt.Errorf("cloudflare: read response: %w", err)
	}
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, fmt.Errorf("cloudflare: %s %s: unexpected response (HTTP %d)", method, path, resp.StatusCode)
	}
	if !env.Success || resp.StatusCode >= 300 {
		msgs := make([]string, 0, len(env.Errors))
		for _, e := range env.Errors {
			msgs = append(msgs, fmt.Sprintf("%d: %s", e.Code, e.Message))
		}
		return nil, fmt.Errorf("cloudflare: %s %s: HTTP %d: %s", method, path, resp.StatusCode, strings.Join(msgs, "; "))
	}
	return env.Result, nil
}

func (c *RealClient) FindZoneID(ctx context.Context, token, hostname string) (string, error) {
	labels := strings.Split(hostname, ".")
	// Longest suffix first, at least two labels (example.com).
	for i := 0; i <= len(labels)-2; i++ {
		candidate := strings.Join(labels[i:], ".")
		res, err := c.do(ctx, token, http.MethodGet, "/zones?per_page=1&name="+url.QueryEscape(candidate), nil)
		if err != nil {
			return "", err
		}
		var zones []struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(res, &zones); err != nil {
			return "", fmt.Errorf("cloudflare: decode zones: %w", err)
		}
		if len(zones) > 0 && zones[0].ID != "" {
			return zones[0].ID, nil
		}
	}
	return "", ErrZoneNotFound
}

type ingressRule struct {
	Hostname string `json:"hostname,omitempty"`
	Service  string `json:"service"`
}

func (c *RealClient) PutTunnelIngress(ctx context.Context, token, accountID, tunnelID string, hostnames []string, service string) error {
	path := fmt.Sprintf("/accounts/%s/cfd_tunnel/%s/configurations", url.PathEscape(accountID), url.PathEscape(tunnelID))

	current, err := c.do(ctx, token, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	var cfg struct {
		Config *struct {
			Ingress []ingressRule `json:"ingress"`
		} `json:"config"`
	}
	if err := json.Unmarshal(current, &cfg); err != nil {
		return fmt.Errorf("cloudflare: decode tunnel configuration: %w", err)
	}
	if cfg.Config != nil {
		for _, r := range cfg.Config.Ingress {
			if r.Service != service && !strings.HasPrefix(r.Service, "http_status:") {
				return ErrForeignIngress
			}
		}
	}

	rules := make([]ingressRule, 0, len(hostnames)+1)
	for _, h := range hostnames {
		rules = append(rules, ingressRule{Hostname: h, Service: service})
	}
	rules = append(rules, ingressRule{Service: "http_status:404"})

	body := map[string]any{"config": map[string]any{"ingress": rules}}
	_, err = c.do(ctx, token, http.MethodPut, path, body)
	return err
}

func (c *RealClient) UpsertTunnelCNAME(ctx context.Context, token, zoneID, hostname, tunnelID string) error {
	base := "/zones/" + url.PathEscape(zoneID) + "/dns_records"
	res, err := c.do(ctx, token, http.MethodGet, base+"?per_page=5&name="+url.QueryEscape(hostname), nil)
	if err != nil {
		return err
	}
	var existing []struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(res, &existing); err != nil {
		return fmt.Errorf("cloudflare: decode dns records: %w", err)
	}

	record := map[string]any{
		"type":    "CNAME",
		"name":    hostname,
		"content": tunnelID + ".cfargotunnel.com",
		"proxied": true,
		"ttl":     1,
	}

	// Only a record that already points at this very tunnel may be updated;
	// anything else belongs to someone/something else and is never overwritten.
	for _, r := range existing {
		if r.Type != "CNAME" || !strings.EqualFold(r.Content, record["content"].(string)) {
			return fmt.Errorf("%w: %s (%s)", ErrDNSConflict, hostname, r.Type)
		}
	}
	if len(existing) > 0 {
		_, err = c.do(ctx, token, http.MethodPut, base+"/"+url.PathEscape(existing[0].ID), record)
		return err
	}
	_, err = c.do(ctx, token, http.MethodPost, base, record)
	return err
}
