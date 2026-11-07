package cloudflare

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const testToken = "tok_SECRET_0123456789abcdef"

type recorded struct {
	Method string
	Path   string
	Query  string
	Auth   string
	Body   string
}

func newServer(t *testing.T, handler func(r *http.Request, body string) (int, string)) (*RealClient, *[]recorded) {
	t.Helper()
	var mu sync.Mutex
	var calls []recorded
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		calls = append(calls, recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), string(b)})
		mu.Unlock()
		status, out := handler(r, string(b))
		w.WriteHeader(status)
		io.WriteString(w, out)
	}))
	t.Cleanup(srv.Close)
	return &RealClient{BaseURL: srv.URL, HTTP: srv.Client()}, &calls
}

func ok(result string) string {
	return `{"success":true,"errors":[],"result":` + result + `}`
}

func TestFindZoneID_LongestSuffix(t *testing.T) {
	c, calls := newServer(t, func(r *http.Request, _ string) (int, string) {
		if r.URL.Query().Get("name") == "example.com" {
			return 200, ok(`[{"id":"zone123"}]`)
		}
		return 200, ok(`[]`)
	})
	id, err := c.FindZoneID(context.Background(), testToken, "www.shop.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if id != "zone123" {
		t.Errorf("zone id = %q", id)
	}
	if len(*calls) != 3 {
		t.Errorf("expected 3 lookups (www.shop.example.com, shop.example.com, example.com), got %d", len(*calls))
	}
	for _, call := range *calls {
		if call.Auth != "Bearer "+testToken {
			t.Errorf("missing bearer auth: %q", call.Auth)
		}
	}
}

func TestFindZoneID_NotFound(t *testing.T) {
	c, _ := newServer(t, func(*http.Request, string) (int, string) { return 200, ok(`[]`) })
	_, err := c.FindZoneID(context.Background(), testToken, "a.example.com")
	if !errors.Is(err, ErrZoneNotFound) {
		t.Errorf("expected ErrZoneNotFound, got %v", err)
	}
}

func TestPutTunnelIngress_Body(t *testing.T) {
	c, calls := newServer(t, func(*http.Request, string) (int, string) { return 200, ok(`{}`) })
	err := c.PutTunnelIngress(context.Background(), testToken, "acc", "tun", []string{"a.example.com", "b.example.com"}, "http://10.255.0.1:80")
	if err != nil {
		t.Fatal(err)
	}
	if get := (*calls)[0]; get.Method != http.MethodGet {
		t.Errorf("the current configuration must be read first, got %s", get.Method)
	}
	call := (*calls)[1]
	if call.Method != http.MethodPut || call.Path != "/accounts/acc/cfd_tunnel/tun/configurations" {
		t.Errorf("unexpected request %s %s", call.Method, call.Path)
	}
	var body struct {
		Config struct {
			Ingress []map[string]string `json:"ingress"`
		} `json:"config"`
	}
	if err := json.Unmarshal([]byte(call.Body), &body); err != nil {
		t.Fatal(err)
	}
	in := body.Config.Ingress
	if len(in) != 3 {
		t.Fatalf("expected 3 rules, got %d", len(in))
	}
	if in[0]["hostname"] != "a.example.com" || in[0]["service"] != "http://10.255.0.1:80" {
		t.Errorf("rule 0 = %v", in[0])
	}
	if in[2]["service"] != "http_status:404" || in[2]["hostname"] != "" {
		t.Errorf("last rule must be catch-all 404, got %v", in[2])
	}
}

func TestUpsertCNAME_Create(t *testing.T) {
	c, calls := newServer(t, func(r *http.Request, _ string) (int, string) {
		if r.Method == http.MethodGet {
			return 200, ok(`[]`)
		}
		return 200, ok(`{"id":"new"}`)
	})
	if err := c.UpsertTunnelCNAME(context.Background(), testToken, "z1", "a.example.com", "tun"); err != nil {
		t.Fatal(err)
	}
	post := (*calls)[1]
	if post.Method != http.MethodPost || post.Path != "/zones/z1/dns_records" {
		t.Errorf("unexpected %s %s", post.Method, post.Path)
	}
	for _, want := range []string{`"type":"CNAME"`, `"content":"tun.cfargotunnel.com"`, `"proxied":true`, `"name":"a.example.com"`} {
		if !strings.Contains(post.Body, want) {
			t.Errorf("body missing %s: %s", want, post.Body)
		}
	}
}

func TestUpsertCNAME_Update(t *testing.T) {
	c, calls := newServer(t, func(r *http.Request, _ string) (int, string) {
		if r.Method == http.MethodGet {
			return 200, ok(`[{"id":"rec1","type":"CNAME","content":"TUN.cfargotunnel.com"}]`)
		}
		return 200, ok(`{}`)
	})
	if err := c.UpsertTunnelCNAME(context.Background(), testToken, "z1", "a.example.com", "tun"); err != nil {
		t.Fatal(err)
	}
	put := (*calls)[1]
	if put.Method != http.MethodPut || put.Path != "/zones/z1/dns_records/rec1" {
		t.Errorf("unexpected %s %s", put.Method, put.Path)
	}
}

func TestUpsertCNAME_ConflictWithOtherType(t *testing.T) {
	c, calls := newServer(t, func(*http.Request, string) (int, string) {
		return 200, ok(`[{"id":"rec1","type":"A"}]`)
	})
	err := c.UpsertTunnelCNAME(context.Background(), testToken, "z1", "a.example.com", "tun")
	if !errors.Is(err, ErrDNSConflict) {
		t.Errorf("expected ErrDNSConflict, got %v", err)
	}
	if len(*calls) != 1 {
		t.Errorf("must not write when a conflicting record exists, got %d calls", len(*calls))
	}
}

func TestErrors_DoNotLeakToken(t *testing.T) {
	c, _ := newServer(t, func(*http.Request, string) (int, string) {
		return 403, `{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}`
	})
	err := c.PutTunnelIngress(context.Background(), testToken, "acc", "tun", nil, "http://x")
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), testToken) {
		t.Error("error leaks the API token")
	}
	if !strings.Contains(err.Error(), "Authentication error") || !strings.Contains(err.Error(), "403") {
		t.Errorf("error should carry CF message and status: %v", err)
	}
}

func TestNonJSONResponse(t *testing.T) {
	c, _ := newServer(t, func(*http.Request, string) (int, string) { return 502, "<html>bad gateway</html>" })
	_, err := c.FindZoneID(context.Background(), testToken, "a.example.com")
	if err == nil || strings.Contains(err.Error(), "<html>") {
		t.Errorf("expected sanitized error, got %v", err)
	}
}

func TestQueryIsEscaped(t *testing.T) {
	c, calls := newServer(t, func(*http.Request, string) (int, string) { return 200, ok(`[]`) })
	c.UpsertTunnelCNAME(context.Background(), testToken, "z1", "a.example.com&type=A", "tun")
	if q := (*calls)[0].Query; strings.Contains(q, "&type=A") {
		t.Errorf("query not escaped: %s", q)
	}
}

func TestUpsertCNAME_ConflictWithRecordOfAnotherTarget(t *testing.T) {
	c, calls := newServer(t, func(*http.Request, string) (int, string) {
		return 200, ok(`[{"id":"rec1","type":"CNAME","content":"other.example.net"}]`)
	})
	err := c.UpsertTunnelCNAME(context.Background(), testToken, "z1", "a.example.com", "tun")
	if !errors.Is(err, ErrDNSConflict) {
		t.Errorf("expected ErrDNSConflict, got %v", err)
	}
	if len(*calls) != 1 {
		t.Errorf("must not overwrite a foreign CNAME, got %d calls", len(*calls))
	}
}

func TestPutTunnelIngress_RefusesForeignRules(t *testing.T) {
	c, calls := newServer(t, func(r *http.Request, _ string) (int, string) {
		return 200, ok(`{"config":{"ingress":[{"hostname":"ssh.example.com","service":"ssh://localhost:22"},{"service":"http_status:404"}]}}`)
	})
	err := c.PutTunnelIngress(context.Background(), testToken, "acc", "tun", []string{"a.example.com"}, "http://10.255.0.1:80")
	if !errors.Is(err, ErrForeignIngress) {
		t.Fatalf("expected ErrForeignIngress, got %v", err)
	}
	for _, call := range *calls {
		if call.Method == http.MethodPut {
			t.Error("must not PUT when the tunnel has foreign rules")
		}
	}
}

func TestPutTunnelIngress_AcceptsOwnRulesAndCatchAll(t *testing.T) {
	c, calls := newServer(t, func(*http.Request, string) (int, string) {
		return 200, ok(`{"config":{"ingress":[{"hostname":"old.example.com","service":"http://10.255.0.1:80"},{"service":"http_status:404"}]}}`)
	})
	if err := c.PutTunnelIngress(context.Background(), testToken, "acc", "tun", []string{"a.example.com"}, "http://10.255.0.1:80"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 2 || (*calls)[1].Method != http.MethodPut {
		t.Errorf("expected GET then PUT, got %v", *calls)
	}
}
