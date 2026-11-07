package actions

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/m4rtins/forja/agent/internal/caddy"
	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const testCFToken = "cf_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123"

func certFixture() (*osutil.FakeExecutor, *caddy.FakeClient) {
	fx := osutil.NewFakeExecutor()
	fx.LookupResult["fj-demo"] = [2]int{2001, 2001}
	fx.LookupResult["fj-other"] = [2]int{2002, 2002}
	fx.LookupResult[caddyUser] = [2]int{990, 991}
	return fx, &caddy.FakeClient{}
}

func certParams(mut func(*CertParams)) json.RawMessage {
	p := CertParams{AccountSlug: "demo", Domain: "example.com", CFAPIToken: testCFToken}
	if mut != nil {
		mut(&p)
	}
	b, _ := json.Marshal(p)
	return b
}

func makeCertPEM(t *testing.T, notBefore, notAfter time.Time) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "example.com"}, NotBefore: notBefore, NotAfter: notAfter}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func TestCert_Names(t *testing.T) {
	assert.Equal(t, "cert.request", (&CertRequest{}).Name())
	assert.Equal(t, "cert.renew", (&CertRenew{}).Name())
	assert.Equal(t, "cert.status", (&CertStatus{}).Name())
}

func TestCert_Validate_OK(t *testing.T) {
	assert.NoError(t, (&CertRequest{}).Validate(certParams(nil)))
	assert.NoError(t, (&CertRenew{}).Validate(certParams(nil)))
}

func TestCert_Validate_Malicious(t *testing.T) {
	cases := map[string]func(*CertParams){
		"slug traversal":      func(p *CertParams) { p.AccountSlug = "../etc" },
		"slug empty":          func(p *CertParams) { p.AccountSlug = "" },
		"slug leading dash":   func(p *CertParams) { p.AccountSlug = "-rf" },
		"slug unicode":        func(p *CertParams) { p.AccountSlug = "démo" },
		"domain traversal":    func(p *CertParams) { p.Domain = "../../etc/passwd" },
		"domain slash":        func(p *CertParams) { p.Domain = "example.com/../x" },
		"domain wildcard":     func(p *CertParams) { p.Domain = "*.example.com" },
		"domain empty":        func(p *CertParams) { p.Domain = "" },
		"domain uppercase":    func(p *CertParams) { p.Domain = "Example.com" },
		"domain leading dash": func(p *CertParams) { p.Domain = "-x.example.com" },
		"domain newline":      func(p *CertParams) { p.Domain = "example.com\nfoo.com" },
		"domain control":      func(p *CertParams) { p.Domain = "exa\x00mple.com" },
		"domain unicode":      func(p *CertParams) { p.Domain = "exámple.com" },
		"domain too long":     func(p *CertParams) { p.Domain = strings.Repeat("a", 300) + ".com" },
		"domain one label":    func(p *CertParams) { p.Domain = "localhost" },
		"token empty":         func(p *CertParams) { p.CFAPIToken = "" },
		"token short":         func(p *CertParams) { p.CFAPIToken = "abc" },
		"token newline":       func(p *CertParams) { p.CFAPIToken = testCFToken + "\nX=1" },
		"token placeholder":   func(p *CertParams) { p.CFAPIToken = "{file./etc/shadow}{file./etc/shadow}" },
		"token quote":         func(p *CertParams) { p.CFAPIToken = testCFToken + `"}` },
		"token too long":      func(p *CertParams) { p.CFAPIToken = strings.Repeat("A", 500) },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			for _, a := range []interface{ Validate(json.RawMessage) error }{&CertRequest{}, &CertRenew{}} {
				err := a.Validate(certParams(mut))
				require.Error(t, err)
				assert.True(t, errors.Is(err, validate.ErrInvalid))
				assert.NotContains(t, err.Error(), testCFToken)
			}
		})
	}
	assert.Error(t, (&CertRequest{}).Validate(json.RawMessage(`{`)))
	assert.Error(t, (&CertStatus{}).Validate(json.RawMessage(`{"account_slug":"demo","domain":"../x"}`)))
}

func TestCertRequest_Execute(t *testing.T) {
	fx, cd := certFixture()
	a := &CertRequest{OS: fx, Caddy: cd}
	res, err := a.Execute(context.Background(), certParams(nil))
	require.NoError(t, err)
	r := res.(*CertResult)
	assert.Equal(t, "example.com", r.Domain)
	assert.Equal(t, CertStatusPending, r.Status)

	// Token file: private to root + caddy group, no newline, never in the Caddy config.
	tokenPath := "/srv/forja/certs/tokens/demo.token"
	assert.Equal(t, testCFToken, string(fx.WriteFileData[tokenPath]))
	var mode string
	for _, c := range fx.Calls {
		if c.Method == "WriteFileAtomic" && c.Args[0] == tokenPath {
			mode = c.Args[1] + ":" + c.Args[2] + ":" + c.Args[3]
		}
	}
	assert.Equal(t, "0640:0:991", mode)

	require.Len(t, cd.SetCalls, 1)
	assert.Equal(t, "apps/tls", cd.SetCalls[0].Path)
	cfg := string(cd.SetCalls[0].Config)
	assert.NotContains(t, cfg, testCFToken)
	assert.Contains(t, cfg, "{file."+tokenPath+"}")
	assert.Contains(t, cfg, `"name":"cloudflare"`)
	assert.Contains(t, cfg, `"automate":["example.com"]`)
	assert.Empty(t, cd.Calls, "must not replace the whole config")

	// No shell, no exec at all.
	for _, c := range fx.Calls {
		assert.NotContains(t, []string{"Run", "RunAs"}, c.Method)
	}
}

func TestCertRequest_Idempotent(t *testing.T) {
	fx, cd := certFixture()
	a := &CertRequest{OS: fx, Caddy: cd}
	for i := 0; i < 2; i++ {
		_, err := a.Execute(context.Background(), certParams(nil))
		require.NoError(t, err)
	}
	st, err := loadCertState(fx)
	require.NoError(t, err)
	assert.Len(t, st.Certs, 1)
}

func TestCertRequest_DomainOfAnotherAccount(t *testing.T) {
	fx, cd := certFixture()
	a := &CertRequest{OS: fx, Caddy: cd}
	_, err := a.Execute(context.Background(), certParams(nil))
	require.NoError(t, err)
	_, err = a.Execute(context.Background(), certParams(func(p *CertParams) { p.AccountSlug = "other" }))
	require.Error(t, err)
	assert.True(t, errors.Is(err, validate.ErrInvalid))
	st, _ := loadCertState(fx)
	require.Len(t, st.Certs, 1)
	assert.Equal(t, "demo", st.Certs[0].AccountSlug)
}

func TestCertRequest_UnknownAccountAndCaddyErr(t *testing.T) {
	fx, cd := certFixture()
	_, err := (&CertRequest{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(func(p *CertParams) { p.AccountSlug = "ghost" }))
	assert.Error(t, err)
	assert.Empty(t, cd.SetCalls)

	cd.SetErr = errors.New("boom")
	_, err = (&CertRequest{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(nil))
	require.Error(t, err)
	assert.NotContains(t, err.Error(), testCFToken)
}

func TestCertRenew_RequiresPriorRequest(t *testing.T) {
	fx, cd := certFixture()
	_, err := (&CertRenew{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(nil))
	require.Error(t, err)
	assert.True(t, errors.Is(err, validate.ErrInvalid))
	assert.Empty(t, cd.SetCalls)
}

func TestCertRenew_ReappliesAndRotatesToken(t *testing.T) {
	fx, cd := certFixture()
	_, err := (&CertRequest{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(nil))
	require.NoError(t, err)

	newTok := "rotated_token_ABCDEFGHIJKLMNOPQRST"
	crt := makeCertPEM(t, time.Now().Add(-60*24*time.Hour), time.Now().Add(20*24*time.Hour))
	fx.ReadFileData[filepath.Join(caddyCertStorage, "example.com", "example.com.crt")] = crt

	res, err := (&CertRenew{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(func(p *CertParams) { p.CFAPIToken = newTok }))
	require.NoError(t, err)
	r := res.(*CertResult)
	assert.Equal(t, CertStatusActive, r.Status)
	assert.NotEmpty(t, r.ExpiresAt)
	assert.Equal(t, newTok, string(fx.WriteFileData["/srv/forja/certs/tokens/demo.token"]))
	assert.Len(t, cd.SetCalls, 2)
}

func TestReadCertStatus(t *testing.T) {
	fx := osutil.NewFakeExecutor()
	path := filepath.Join(caddyCertStorage, "example.com", "example.com.crt")
	now := time.Now()

	r, err := readCertStatus(fx, "example.com", now)
	require.NoError(t, err)
	assert.Equal(t, CertStatusPending, r.Status)

	fx.ReadFileData[path] = []byte("garbage")
	r, _ = readCertStatus(fx, "example.com", now)
	assert.Equal(t, CertStatusPending, r.Status)

	fx.ReadFileData[path] = makeCertPEM(t, now.Add(-100*24*time.Hour), now.Add(-10*24*time.Hour))
	r, _ = readCertStatus(fx, "example.com", now)
	assert.Equal(t, CertStatusExpired, r.Status)

	fx.ReadFileData[path] = makeCertPEM(t, now.Add(-time.Hour), now.Add(89*24*time.Hour))
	r, _ = readCertStatus(fx, "example.com", now)
	assert.Equal(t, CertStatusActive, r.Status)
}

func TestCertStatus_Execute(t *testing.T) {
	fx, cd := certFixture()
	a := &CertStatus{OS: fx}
	sp := json.RawMessage(`{"account_slug":"demo","domain":"example.com"}`)
	_, err := a.Execute(context.Background(), sp)
	require.Error(t, err, "unknown domain")

	_, err = (&CertRequest{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(nil))
	require.NoError(t, err)
	res, err := a.Execute(context.Background(), sp)
	require.NoError(t, err)
	assert.Equal(t, CertStatusPending, res.(*CertResult).Status)

	_, err = a.Execute(context.Background(), json.RawMessage(`{"account_slug":"other","domain":"example.com"}`))
	require.Error(t, err, "another account")
}

func TestBuildTLSApp(t *testing.T) {
	assert.Nil(t, buildTLSApp(&certState{}))
	tls := buildTLSApp(&certState{Certs: []certEntry{
		{Domain: "b.com", AccountSlug: "demo"}, {Domain: "a.com", AccountSlug: "demo"}, {Domain: "c.com", AccountSlug: "other"},
	}})
	require.NotNil(t, tls)
	assert.Equal(t, []string{"a.com", "b.com", "c.com"}, tls.Certificates.Automate)
	require.Len(t, tls.Automation.Policies, 2)
	assert.Equal(t, []string{"a.com", "b.com"}, tls.Automation.Policies[0].Subjects)
}

func TestCaddySync_KeepsTLSPolicies(t *testing.T) {
	fx, cd := certFixture()
	_, err := (&CertRequest{OS: fx, Caddy: cd}).Execute(context.Background(), certParams(nil))
	require.NoError(t, err)

	params, _ := json.Marshal(CaddySyncParams{Sites: []CaddySiteEntry{onlineSite()}})
	_, err = (&CaddySync{Caddy: cd, OS: fx}).Execute(context.Background(), params)
	require.NoError(t, err)
	require.Len(t, cd.Calls, 1)
	assert.Contains(t, string(cd.Calls[0]), `"tls":{`)
	assert.Contains(t, string(cd.Calls[0]), `"automate":["example.com"]`)
	assert.NotContains(t, string(cd.Calls[0]), testCFToken)

	// A corrupt state file must not silently drop certificates.
	fx.WriteFileData[certStateFile] = []byte("{nope")
	_, err = (&CaddySync{Caddy: cd, OS: fx}).Execute(context.Background(), params)
	assert.Error(t, err)

	// Missing state: no TLS app.
	fx2 := osutil.NewFakeExecutor()
	cd2 := &caddy.FakeClient{}
	_, err = (&CaddySync{Caddy: cd2, OS: fx2}).Execute(context.Background(), params)
	require.NoError(t, err)
	assert.NotContains(t, string(cd2.Calls[0]), `"tls"`)
	_ = os.ErrNotExist
}

// Minimal stand-ins for testify (not a dependency of this module): assert keeps
// going after a failure, require stops.
type certAsserter struct{ fatal bool }

var (
	assert  = certAsserter{}
	require = certAsserter{fatal: true}
)

func (a certAsserter) fail(t *testing.T, format string, args ...any) bool {
	t.Helper()
	t.Errorf(format, args...)
	if a.fatal {
		t.FailNow()
	}
	return false
}

func (a certAsserter) Equal(t *testing.T, want, got any, _ ...any) bool {
	t.Helper()
	if !reflect.DeepEqual(want, got) {
		return a.fail(t, "want %#v, got %#v", want, got)
	}
	return true
}

func isEmpty(v any) bool {
	if v == nil {
		return true
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Slice, reflect.Map, reflect.String, reflect.Array:
		return rv.Len() == 0
	}
	return rv.IsZero()
}

func (a certAsserter) Empty(t *testing.T, v any, _ ...any) bool {
	t.Helper()
	if !isEmpty(v) {
		return a.fail(t, "expected empty, got %#v", v)
	}
	return true
}

func (a certAsserter) NotEmpty(t *testing.T, v any, _ ...any) bool {
	t.Helper()
	if isEmpty(v) {
		return a.fail(t, "expected non-empty")
	}
	return true
}

func (a certAsserter) NoError(t *testing.T, err error, _ ...any) bool {
	t.Helper()
	if err != nil {
		return a.fail(t, "unexpected error: %v", err)
	}
	return true
}

func (a certAsserter) Error(t *testing.T, err error, _ ...any) bool {
	t.Helper()
	if err == nil {
		return a.fail(t, "expected an error")
	}
	return true
}

func (a certAsserter) True(t *testing.T, v bool, _ ...any) bool {
	t.Helper()
	if !v {
		return a.fail(t, "expected true")
	}
	return true
}

func (a certAsserter) Nil(t *testing.T, v any, _ ...any) bool {
	t.Helper()
	if v != nil && !reflect.ValueOf(v).IsNil() {
		return a.fail(t, "expected nil, got %#v", v)
	}
	return true
}

func (a certAsserter) NotNil(t *testing.T, v any, _ ...any) bool {
	t.Helper()
	if v == nil || reflect.ValueOf(v).IsNil() {
		return a.fail(t, "expected non-nil")
	}
	return true
}

func (a certAsserter) Len(t *testing.T, v any, n int, _ ...any) bool {
	t.Helper()
	if l := reflect.ValueOf(v).Len(); l != n {
		return a.fail(t, "want len %d, got %d", n, l)
	}
	return true
}

func contains(container, item any) bool {
	if s, ok := container.(string); ok {
		return strings.Contains(s, fmt.Sprint(item))
	}
	rv := reflect.ValueOf(container)
	for i := 0; i < rv.Len(); i++ {
		if reflect.DeepEqual(rv.Index(i).Interface(), item) {
			return true
		}
	}
	return false
}

func (a certAsserter) Contains(t *testing.T, container, item any, _ ...any) bool {
	t.Helper()
	if !contains(container, item) {
		return a.fail(t, "%v does not contain %v", container, item)
	}
	return true
}

func (a certAsserter) NotContains(t *testing.T, container, item any, _ ...any) bool {
	t.Helper()
	if contains(container, item) {
		return a.fail(t, "%v unexpectedly contains %v", container, item)
	}
	return true
}
