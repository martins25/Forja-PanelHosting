package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/cloudflare"
)

const testAPIToken = "cfapitoken_ABCDEFGHIJKLMNOP-1234"

type fakeCF struct {
	zones      map[string]string // hostname -> zone id
	zoneErr    error
	ingressErr error
	cnameErr   map[string]error

	ingressHosts   []string
	ingressService string
	ingressCalls   int
	cnames         map[string]string // hostname -> zone id
	tokens         map[string]bool
}

func newFakeCF() *fakeCF {
	return &fakeCF{zones: map[string]string{}, cnameErr: map[string]error{}, cnames: map[string]string{}, tokens: map[string]bool{}}
}

func (f *fakeCF) FindZoneID(_ context.Context, token, hostname string) (string, error) {
	f.tokens[token] = true
	if f.zoneErr != nil {
		return "", f.zoneErr
	}
	if z, ok := f.zones[hostname]; ok {
		return z, nil
	}
	return "", cloudflare.ErrZoneNotFound
}

func (f *fakeCF) PutTunnelIngress(_ context.Context, token, _, _ string, hostnames []string, service string) error {
	f.tokens[token] = true
	f.ingressCalls++
	f.ingressHosts = hostnames
	f.ingressService = service
	return f.ingressErr
}

func (f *fakeCF) UpsertTunnelCNAME(_ context.Context, _ string, zoneID, hostname, _ string) error {
	if err := f.cnameErr[hostname]; err != nil {
		return err
	}
	f.cnames[hostname] = zoneID
	return nil
}

func syncParams(domains ...string) json.RawMessage {
	b, _ := json.Marshal(CFRoutesSyncParams{
		ConnectionID: 7,
		CFAccountID:  testCFAccount,
		TunnelID:     testTunnelID,
		APIToken:     testAPIToken,
		Domains:      domains,
	})
	return b
}

func TestCFRoutesSync_Name(t *testing.T) {
	if (&CFRoutesSync{}).Name() != "cf.routes.sync" {
		t.Error("wrong name")
	}
}

func TestCFRoutesSync_Validate_OK(t *testing.T) {
	a := &CFRoutesSync{CF: newFakeCF()}
	for _, d := range [][]string{nil, {"example.com"}, {"a.example.com", "b.example.com"}} {
		if err := a.Validate(syncParams(d...)); err != nil {
			t.Errorf("domains %v should be valid: %v", d, err)
		}
	}
}

func TestCFRoutesSync_Validate_Malicious(t *testing.T) {
	a := &CFRoutesSync{CF: newFakeCF()}
	cases := map[string]func(*CFRoutesSyncParams){
		"connection zero":      func(p *CFRoutesSyncParams) { p.ConnectionID = 0 },
		"account id short":     func(p *CFRoutesSyncParams) { p.CFAccountID = "abc" },
		"account id traversal": func(p *CFRoutesSyncParams) { p.CFAccountID = "../../zones/xxxxxxxxxxxxxxxxxxxx" },
		"tunnel id slash":      func(p *CFRoutesSyncParams) { p.TunnelID = testTunnelID + "/../x" },
		"token empty":          func(p *CFRoutesSyncParams) { p.APIToken = "" },
		"token newline":        func(p *CFRoutesSyncParams) { p.APIToken = testAPIToken + "\r\nX-Evil: 1" },
		"token space":          func(p *CFRoutesSyncParams) { p.APIToken = "abc def ghijklmnopqrstuvwxyz" },
		"domain wildcard":      func(p *CFRoutesSyncParams) { p.Domains = []string{"*.example.com"} },
		"domain uppercase":     func(p *CFRoutesSyncParams) { p.Domains = []string{"EXAMPLE.com"} },
		"domain query inject":  func(p *CFRoutesSyncParams) { p.Domains = []string{"a.example.com&type=A"} },
		"domain path":          func(p *CFRoutesSyncParams) { p.Domains = []string{"a.example.com/../x"} },
		"domain dash":          func(p *CFRoutesSyncParams) { p.Domains = []string{"-a.example.com"} },
		"domain unicode":       func(p *CFRoutesSyncParams) { p.Domains = []string{"ejemplo-ñ.com"} },
		"domain empty":         func(p *CFRoutesSyncParams) { p.Domains = []string{""} },
		"domain duplicate":     func(p *CFRoutesSyncParams) { p.Domains = []string{"a.example.com", "a.example.com"} },
		"too many domains": func(p *CFRoutesSyncParams) {
			p.Domains = nil
			for i := 0; i <= maxCFDomains; i++ {
				p.Domains = append(p.Domains, fmt.Sprintf("d%d.example.com", i))
			}
		},
	}
	for name, mut := range cases {
		p := CFRoutesSyncParams{ConnectionID: 7, CFAccountID: testCFAccount, TunnelID: testTunnelID, APIToken: testAPIToken, Domains: []string{"ok.example.com"}}
		mut(&p)
		b, _ := json.Marshal(p)
		if err := a.Validate(b); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
}

func TestCFRoutesSync_Execute_OK(t *testing.T) {
	f := newFakeCF()
	f.zones["a.example.com"] = "zoneA"
	f.zones["b.other.org"] = "zoneB"
	a := &CFRoutesSync{CF: f}

	res, err := a.Execute(context.Background(), syncParams("a.example.com", "b.other.org"))
	if err != nil {
		t.Fatal(err)
	}
	r := res.(*CFRoutesSyncResult)
	if r.Failed != 0 || len(r.Domains) != 2 {
		t.Errorf("result = %+v", r)
	}
	if f.ingressCalls != 1 || len(f.ingressHosts) != 2 {
		t.Errorf("ingress calls=%d hosts=%v", f.ingressCalls, f.ingressHosts)
	}
	if f.ingressService != "http://10.255.0.1:80" {
		t.Errorf("ingress service = %q", f.ingressService)
	}
	if f.cnames["a.example.com"] != "zoneA" || f.cnames["b.other.org"] != "zoneB" {
		t.Errorf("cnames = %v", f.cnames)
	}
}

func TestCFRoutesSync_Execute_ZoneNotFoundIsPartial(t *testing.T) {
	f := newFakeCF()
	f.zones["a.example.com"] = "zoneA"
	a := &CFRoutesSync{CF: f}

	res, err := a.Execute(context.Background(), syncParams("a.example.com", "x.nozone.net"))
	if err != nil {
		t.Fatal(err)
	}
	r := res.(*CFRoutesSyncResult)
	if r.Failed != 1 {
		t.Errorf("expected 1 failure, got %+v", r)
	}
	for _, d := range r.Domains {
		if d.Hostname == "x.nozone.net" && d.Code != "ZONE_NOT_FOUND" {
			t.Errorf("code = %q", d.Code)
		}
	}
	if len(f.ingressHosts) != 1 || f.ingressHosts[0] != "a.example.com" {
		t.Errorf("only routable hosts go in the ingress, got %v", f.ingressHosts)
	}
	if _, ok := f.cnames["x.nozone.net"]; ok {
		t.Error("no CNAME for a domain without zone")
	}
}

func TestCFRoutesSync_Execute_CNAMEFailureIsPerDomain(t *testing.T) {
	f := newFakeCF()
	f.zones["a.example.com"] = "zoneA"
	f.zones["b.example.com"] = "zoneA"
	f.cnameErr["a.example.com"] = cloudflare.ErrDNSConflict
	a := &CFRoutesSync{CF: f}

	res, err := a.Execute(context.Background(), syncParams("a.example.com", "b.example.com"))
	if err != nil {
		t.Fatal(err)
	}
	r := res.(*CFRoutesSyncResult)
	if r.Failed != 1 {
		t.Errorf("result = %+v", r)
	}
	for _, d := range r.Domains {
		if d.Hostname == "a.example.com" && d.Code != "DNS_CONFLICT" {
			t.Errorf("code = %q", d.Code)
		}
	}
	if raw, _ := json.Marshal(r); strings.Contains(string(raw), "cloudflare:") {
		t.Error("provider messages must not appear in the result")
	}
	if f.cnames["b.example.com"] != "zoneA" {
		t.Error("b.example.com should still be created")
	}
}

func TestCFRoutesSync_Execute_IngressFailureIsFatal(t *testing.T) {
	f := newFakeCF()
	f.zones["a.example.com"] = "zoneA"
	f.ingressErr = errors.New("cloudflare: HTTP 403")
	a := &CFRoutesSync{CF: f}
	if _, err := a.Execute(context.Background(), syncParams("a.example.com")); err == nil {
		t.Fatal("expected error")
	}
	if len(f.cnames) != 0 {
		t.Error("no CNAME must be written when the ingress update failed")
	}
}

func TestCFRoutesSync_Execute_ZoneLookupErrorIsFatal(t *testing.T) {
	f := newFakeCF()
	f.zoneErr = errors.New("cloudflare: HTTP 401")
	a := &CFRoutesSync{CF: f}
	if _, err := a.Execute(context.Background(), syncParams("a.example.com")); err == nil {
		t.Fatal("expected error")
	}
	if f.ingressCalls != 0 {
		t.Error("ingress must not be replaced if zone lookup failed")
	}
}

func TestCFRoutesSync_Execute_EmptyDomains(t *testing.T) {
	f := newFakeCF()
	a := &CFRoutesSync{CF: f}
	if _, err := a.Execute(context.Background(), syncParams()); err != nil {
		t.Fatal(err)
	}
	if f.ingressCalls != 1 || len(f.ingressHosts) != 0 {
		t.Error("empty list should still reset the ingress to catch-all only")
	}
}
