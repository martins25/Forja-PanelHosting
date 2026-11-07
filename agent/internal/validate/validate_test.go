package validate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSlug(t *testing.T) {
	valid := []string{"abc", "my-site", "a12", "a-b-c", "abc-def-ghi-jkl-mnop-qrst-uv"}
	for _, s := range valid {
		if err := Slug(s); err != nil {
			t.Errorf("Slug(%q) should be valid, got: %v", s, err)
		}
	}

	invalid := []string{
		"", "ab", "Ab", "ABC", "1abc", "-abc", "abc_def",
		"abc def", "abc.def", "../etc", "a--b--c--d--e--f--g--h--i--j--k--l",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
	for _, s := range invalid {
		if err := Slug(s); err == nil {
			t.Errorf("Slug(%q) should be invalid", s)
		}
	}
}

func TestHostname(t *testing.T) {
	valid := []string{"example.com", "sub.example.com", "a.b.c.d.example.com", "my-site.io"}
	for _, h := range valid {
		if err := Hostname(h); err != nil {
			t.Errorf("Hostname(%q) should be valid, got: %v", h, err)
		}
	}

	invalid := []string{
		"", "localhost", "EXAMPLE.COM", "*.example.com", "example",
		"-example.com", "example-.com", "example..com",
		"exa mple.com",
	}
	for _, h := range invalid {
		if err := Hostname(h); err == nil {
			t.Errorf("Hostname(%q) should be invalid", h)
		}
	}
}

func TestDBName(t *testing.T) {
	valid := []string{"mydb", "my_db", "abc_123_def"}
	for _, n := range valid {
		if err := DBName(n); err != nil {
			t.Errorf("DBName(%q) should be valid, got: %v", n, err)
		}
	}

	invalid := []string{"", "ab", "1db", "my-db", "MY_DB", "../etc/passwd", "a b"}
	for _, n := range invalid {
		if err := DBName(n); err == nil {
			t.Errorf("DBName(%q) should be invalid", n)
		}
	}
}

func TestDBUser(t *testing.T) {
	valid := []string{"admin", "user_1"}
	for _, u := range valid {
		if err := DBUser(u); err != nil {
			t.Errorf("DBUser(%q) should be valid, got: %v", u, err)
		}
	}

	invalid := []string{"", "ab", "1user", "root; DROP TABLE", "admin'--"}
	for _, u := range invalid {
		if err := DBUser(u); err == nil {
			t.Errorf("DBUser(%q) should be invalid", u)
		}
	}
}

func TestGitBranch(t *testing.T) {
	valid := []string{"main", "feature/login", "v1.0.0", "release/2024-01-01", "fix_bug"}
	for _, b := range valid {
		if err := GitBranch(b); err != nil {
			t.Errorf("GitBranch(%q) should be valid, got: %v", b, err)
		}
	}

	invalid := []string{
		"", "-main", "feat..ure", "branch with spaces",
		"branch\ttab", "$(cmd)", "`cmd`", "a;b", "a|b",
		"a&b",
	}
	for _, b := range invalid {
		if err := GitBranch(b); err == nil {
			t.Errorf("GitBranch(%q) should be invalid", b)
		}
	}
}

func TestSafePath(t *testing.T) {
	base := t.TempDir()
	subdir := filepath.Join(base, "sub")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Valid path
	got, err := SafePath(base, "sub")
	if err != nil {
		t.Fatalf("SafePath(%q, %q) should be valid, got: %v", base, "sub", err)
	}
	if got != subdir {
		t.Errorf("expected %q, got %q", subdir, got)
	}

	// Non-existent file in existing parent
	got, err = SafePath(base, "sub/newfile.txt")
	if err != nil {
		t.Fatalf("SafePath for new file failed: %v", err)
	}
	expected := filepath.Join(subdir, "newfile.txt")
	if got != expected {
		t.Errorf("expected %q, got %q", expected, got)
	}

	// Traversal attack
	_, err = SafePath(base, "../../../etc/passwd")
	if err == nil {
		t.Error("SafePath should reject traversal")
	}

	// Traversal with Clean bypass attempt
	_, err = SafePath(base, "sub/../../etc/passwd")
	if err == nil {
		t.Error("SafePath should reject nested traversal")
	}

	// Empty path
	_, err = SafePath(base, "")
	if err == nil {
		t.Error("SafePath should reject empty path")
	}
}

func TestSafePathSymlink(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()

	outsideFile := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(outsideFile, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}

	link := filepath.Join(base, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks not supported")
	}

	_, err := SafePath(base, "escape/secret.txt")
	if err == nil {
		t.Error("SafePath should reject symlink that escapes base")
	}
}

func TestNoLeadingDash(t *testing.T) {
	if err := NoLeadingDash("hello"); err != nil {
		t.Errorf("should accept 'hello': %v", err)
	}
	if err := NoLeadingDash("-rf"); err == nil {
		t.Error("should reject '-rf'")
	}
	if err := NoLeadingDash("--help"); err == nil {
		t.Error("should reject '--help'")
	}
	if err := NoLeadingDash(""); err != nil {
		t.Error("should accept empty string")
	}
}

func TestPort(t *testing.T) {
	if err := Port(80); err != nil {
		t.Errorf("Port(80) should be valid: %v", err)
	}
	if err := Port(0); err == nil {
		t.Error("Port(0) should be invalid")
	}
	if err := Port(65536); err == nil {
		t.Error("Port(65536) should be invalid")
	}
	if err := Port(-1); err == nil {
		t.Error("Port(-1) should be invalid")
	}
}

func TestRepoURL(t *testing.T) {
	valid := []string{
		"https://github.com/user/repo",
		"https://github.com/user/repo.git",
		"https://github.com/my-org/my-repo",
		"https://github.com/User123/Repo.Name",
		"https://git.example.com/owner/repo.git",
		"https://gitea.mi-dominio.es/owner/repo",
		"https://git.example.com:3000/owner/repo.git",
	}
	for _, u := range valid {
		if err := RepoURL(u); err != nil {
			t.Errorf("RepoURL(%q) should be valid, got: %v", u, err)
		}
	}

	invalid := []string{
		"",
		"http://github.com/user/repo",
		"git@github.com:user/repo.git",
		"https://gitlab.com/user",
		"https://github.com/user/repo/tree/main",
		"https://github.com/user/repo?tab=code",
		"https://github.com/user/../etc",
		"https://github.com/user",
		"ssh://github.com/user/repo",
		"https://127.0.0.1/user/repo",
		"https://10.0.0.5:3000/user/repo.git",
		"https://localhost/user/repo",
		"https://gitea.localhost/user/repo",
		"https://git.internal/user/repo",
		"https://git.example.com:0/user/repo",
		"https://git.example.com:99999/user/repo",
		"https://user:pass@git.example.com/user/repo",
		"https://Git.Example.com/user/repo",
		"https://git.example.com/../repo",
		"https://git.example.com/user/..",
		"https://git.example.com/user/repo git",
		"https://git.example.com//repo",
		"https://-evil.example.com/user/repo",
	}
	for _, u := range invalid {
		if err := RepoURL(u); err == nil {
			t.Errorf("RepoURL(%q) should be invalid", u)
		}
	}
}

func TestCommitSHA(t *testing.T) {
	valid := []string{
		"abc1234",
		"abc1234567890abc1234567890abc1234567890a",
		"0123456789abcdef0123456789abcdef01234567",
	}
	for _, s := range valid {
		if err := CommitSHA(s); err != nil {
			t.Errorf("CommitSHA(%q) should be valid, got: %v", s, err)
		}
	}

	invalid := []string{
		"",
		"abc123",
		"ABC1234",
		"xyz1234",
		"abc123g",
		"abc 1234",
	}
	for _, s := range invalid {
		if err := CommitSHA(s); err == nil {
			t.Errorf("CommitSHA(%q) should be invalid", s)
		}
	}
}

func TestNodeVersion(t *testing.T) {
	valid := []string{"18", "20", "22", "24"}
	for _, v := range valid {
		if err := NodeVersion(v); err != nil {
			t.Errorf("NodeVersion(%q) should be valid, got: %v", v, err)
		}
	}

	invalid := []string{"", "17", "19", "21", "latest", "20.1.0", "v20", "node"}
	for _, v := range invalid {
		if err := NodeVersion(v); err == nil {
			t.Errorf("NodeVersion(%q) should be invalid", v)
		}
	}
}

func TestPHPVersion(t *testing.T) {
	valid := []string{"8.1", "8.2", "8.3", "8.4"}
	for _, v := range valid {
		if err := PHPVersion(v); err != nil {
			t.Errorf("PHPVersion(%q) should be valid, got: %v", v, err)
		}
	}

	invalid := []string{"", "7.4", "8.0", "8.5", "8", "latest", "8.2.1"}
	for _, v := range invalid {
		if err := PHPVersion(v); err == nil {
			t.Errorf("PHPVersion(%q) should be invalid", v)
		}
	}
}

func TestPythonVersion(t *testing.T) {
	valid := []string{"3.11", "3.12", "3.13"}
	for _, v := range valid {
		if err := PythonVersion(v); err != nil {
			t.Errorf("PythonVersion(%q) should be valid, got: %v", v, err)
		}
	}

	invalid := []string{"", "3.10", "3.14", "3", "latest", "3.12.1", "2.7"}
	for _, v := range invalid {
		if err := PythonVersion(v); err == nil {
			t.Errorf("PythonVersion(%q) should be invalid", v)
		}
	}
}

func TestRuntimeVersion(t *testing.T) {
	if err := RuntimeVersion("node", "22"); err != nil {
		t.Errorf("node/22 should be valid: %v", err)
	}
	if err := RuntimeVersion("php", "8.4"); err != nil {
		t.Errorf("php/8.4 should be valid: %v", err)
	}
	if err := RuntimeVersion("python", "3.13"); err != nil {
		t.Errorf("python/3.13 should be valid: %v", err)
	}
	if err := RuntimeVersion("static", ""); err != nil {
		t.Errorf("static/empty should be valid: %v", err)
	}
	if err := RuntimeVersion("docker", ""); err != nil {
		t.Errorf("docker/empty should be valid: %v", err)
	}
	if err := RuntimeVersion("node", "99"); err == nil {
		t.Error("node/99 should be invalid")
	}
	if err := RuntimeVersion("php", "7.4"); err == nil {
		t.Error("php/7.4 should be invalid")
	}
	if err := RuntimeVersion("ruby", "3.2"); err == nil {
		t.Error("ruby should be unsupported runtime")
	}
}

func TestPublicDir(t *testing.T) {
	valid := []string{"", "public", "dist", "www", "build/output", "src/public"}
	for _, d := range valid {
		if err := PublicDir(d); err != nil {
			t.Errorf("PublicDir(%q) should be valid, got: %v", d, err)
		}
	}

	invalid := []string{"../escape", "public/../etc", "/absolute", ".hidden", " spaces"}
	for _, d := range invalid {
		if err := PublicDir(d); err == nil {
			t.Errorf("PublicDir(%q) should be invalid", d)
		}
	}
}

func TestContainerName(t *testing.T) {
	if err := ContainerName(""); err != nil {
		t.Error("should accept empty")
	}
	valid := []string{"fj-demo-example-com-blue", "my.container", "abc-123"}
	for _, n := range valid {
		if err := ContainerName(n); err != nil {
			t.Errorf("ContainerName(%q) should be valid, got: %v", n, err)
		}
	}
	invalid := []string{"--all", "-rf", "../escape", "a b", "AB", "--force"}
	for _, n := range invalid {
		if err := ContainerName(n); err == nil {
			t.Errorf("ContainerName(%q) should be invalid", n)
		}
	}
}

func TestContainerCmd(t *testing.T) {
	if err := ContainerCmd(""); err != nil {
		t.Errorf("ContainerCmd(\"\") should accept empty: %v", err)
	}

	valid := []string{
		"npm ci",
		"npm run build",
		"node dist/index.js",
		"pnpm install --frozen-lockfile",
		"yarn build",
	}
	for _, c := range valid {
		if err := ContainerCmd(c); err != nil {
			t.Errorf("ContainerCmd(%q) should be valid, got: %v", c, err)
		}
	}

	invalid := []string{
		"$(evil)",
		"`cmd`",
		"cmd | other",
		"cmd > file",
		"cmd; rm",
		"cmd && other",
		"cmd\nnewline",
	}
	for _, c := range invalid {
		if err := ContainerCmd(c); err == nil {
			t.Errorf("ContainerCmd(%q) should be invalid", c)
		}
	}
}

func TestEnvKey(t *testing.T) {
	valid := []string{"MY_VAR", "_X", "a1", "NODE_ENV", "PORT", "DB_HOST_NAME", "x"}
	for _, k := range valid {
		if err := EnvKey(k); err != nil {
			t.Errorf("EnvKey(%q) should be valid, got: %v", k, err)
		}
	}

	invalid := []string{
		"",
		"1VAR",
		"MY VAR",
		"MY-VAR",
		"my.var",
		"$(cmd)",
		strings.Repeat("A", 129),
	}
	for _, k := range invalid {
		if err := EnvKey(k); err == nil {
			t.Errorf("EnvKey(%q) should be invalid", k)
		}
	}
}

func TestEnvValue(t *testing.T) {
	if err := EnvValue("hello world"); err != nil {
		t.Errorf("EnvValue should accept normal string: %v", err)
	}
	if err := EnvValue(""); err != nil {
		t.Errorf("EnvValue should accept empty string: %v", err)
	}
	if err := EnvValue("line1\nline2"); err == nil {
		t.Error("EnvValue should reject newlines")
	}
	if err := EnvValue(strings.Repeat("x", 8192)); err != nil {
		t.Errorf("EnvValue should accept 8192 bytes: %v", err)
	}
	if err := EnvValue(strings.Repeat("x", 8193)); err == nil {
		t.Error("EnvValue should reject >8192 bytes")
	}
	if err := EnvValue("hello\x00world"); err == nil {
		t.Error("EnvValue should reject null bytes")
	}
}

func TestDomainSafe(t *testing.T) {
	tests := []struct {
		in, want string
	}{
		{"example.com", "example-com"},
		{"sub.example.com", "sub-example-com"},
		{"my-site.io", "my-site-io"},
		{"a.b.c.d", "a-b-c-d"},
	}
	for _, tt := range tests {
		got := DomainSafe(tt.in)
		if got != tt.want {
			t.Errorf("DomainSafe(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestCloudflareIDs(t *testing.T) {
	const tid = "6ff42ae2-765d-4adf-8112-31c55c1551ef"
	acc := strings.Repeat("a1", 16)
	tok := strings.Repeat("eyJhIjoiYWJj", 4)
	api := strings.Repeat("Ab_-9", 8)

	if err := TunnelID(tid); err != nil {
		t.Errorf("TunnelID valid: %v", err)
	}
	if err := CFAccountID(acc); err != nil {
		t.Errorf("CFAccountID valid: %v", err)
	}
	if err := TunnelToken(tok); err != nil {
		t.Errorf("TunnelToken valid: %v", err)
	}
	if err := CFAPIToken(api); err != nil {
		t.Errorf("CFAPIToken valid: %v", err)
	}

	bad := []string{"", "-rf", "../../etc", "a b", "x\ny", "x\x00y", "$(id)", "a;b", "é" + tid, strings.Repeat("a", 5000)}
	for _, s := range bad {
		if TunnelID(s) == nil {
			t.Errorf("TunnelID(%q) should be invalid", s)
		}
		if CFAccountID(s) == nil {
			t.Errorf("CFAccountID(%q) should be invalid", s)
		}
		if TunnelToken(s) == nil {
			t.Errorf("TunnelToken(%q) should be invalid", s)
		}
		if CFAPIToken(s) == nil {
			t.Errorf("CFAPIToken(%q) should be invalid", s)
		}
	}
	if TunnelID(strings.ToUpper(tid)) == nil {
		t.Error("uppercase tunnel id should be rejected")
	}
	// error must not echo the secret
	if err := CFAPIToken("bad token value"); err != nil && strings.Contains(err.Error(), "bad token value") {
		t.Error("error leaks token value")
	}
}

func TestDBPassword(t *testing.T) {
	valid := []string{"a1b2c3d4e5f6a7b8", "AABB0011CCDD2233", "0123456789abcdef"}
	for _, s := range valid {
		if err := DBPassword(s); err != nil {
			t.Errorf("DBPassword(%q) should be valid, got: %v", s, err)
		}
	}

	invalid := []string{"", "short", "secret123!", "a1b2c3d", "has spaces 1234", "'; DROP TABLE--", "a1b2\x00c3d4e5f6a7b8"}
	for _, s := range invalid {
		if err := DBPassword(s); err == nil {
			t.Errorf("DBPassword(%q) should be invalid", s)
		}
	}
	if err := DBPassword("bad"); err != nil && strings.Contains(err.Error(), "bad") {
		t.Error("error should not echo the password value")
	}
}

func TestDBEngine(t *testing.T) {
	valid := []string{"mariadb", "mysql", "postgres"}
	for _, s := range valid {
		if err := DBEngine(s); err != nil {
			t.Errorf("DBEngine(%q) should be valid, got: %v", s, err)
		}
	}

	invalid := []string{"", "sqlite", "MongoDB", "MYSQL", "Maria", "postgresql", "pg"}
	for _, s := range invalid {
		if err := DBEngine(s); err == nil {
			t.Errorf("DBEngine(%q) should be invalid", s)
		}
	}
}

func TestWebTool(t *testing.T) {
	valid := []string{"phpmyadmin", "adminer", "pgadmin"}
	for _, s := range valid {
		if err := WebTool(s); err != nil {
			t.Errorf("WebTool(%q) should be valid, got: %v", s, err)
		}
	}

	invalid := []string{"", "PhpMyAdmin", "ADMINER", "pgAdmin", "none", "dbeaver"}
	for _, s := range invalid {
		if err := WebTool(s); err == nil {
			t.Errorf("WebTool(%q) should be invalid", s)
		}
	}
}

func TestRemoteKind(t *testing.T) {
	for _, s := range []string{"s3", "r2"} {
		if err := RemoteKind(s); err != nil {
			t.Errorf("RemoteKind(%q) should be valid: %v", s, err)
		}
	}
	for _, s := range []string{"", "S3", "gcs", "s3 ", "s3\n", "-s3"} {
		if err := RemoteKind(s); err == nil {
			t.Errorf("RemoteKind(%q) should be invalid", s)
		}
	}
}

func TestS3Endpoint(t *testing.T) {
	valid := []string{
		"https://s3.eu-west-1.amazonaws.com",
		"https://abc123.r2.cloudflarestorage.com",
		"https://minio.example.com:9000",
	}
	for _, s := range valid {
		if err := S3Endpoint(s); err != nil {
			t.Errorf("S3Endpoint(%q) should be valid: %v", s, err)
		}
	}
	invalid := []string{
		"", "http://s3.amazonaws.com", "s3.amazonaws.com", "https://", "https://localhost",
		"https://127.0.0.1", "https://127.1", "https://[::1]", "https://10.0.0.1:9000",
		"https://169.254.169.254", "https://0x7f.1", "https://foo.internal", "https://foo.local",
		"https://foo.localhost", "https://user:pw@s3.example.com", "https://s3.example.com/bucket",
		"https://s3.example.com?x=1", "https://s3.example.com:99999", "https://s3.example.com:0",
		"https://S3.Example.com", "https://s3.example.com\n", "https://s3.example.com -o x",
		"-https://s3.example.com", "https://s3..example.com", "https://*.example.com",
		"https://" + strings.Repeat("a", 300) + ".com",
	}
	for _, s := range invalid {
		if err := S3Endpoint(s); err == nil {
			t.Errorf("S3Endpoint(%q) should be invalid", s)
		}
	}
}

func TestS3Bucket(t *testing.T) {
	for _, s := range []string{"abc", "my-bucket", "forja.backups.01", "a1b"} {
		if err := S3Bucket(s); err != nil {
			t.Errorf("S3Bucket(%q) should be valid: %v", s, err)
		}
	}
	for _, s := range []string{"", "ab", "-abc", "abc-", ".abc", "AB-C", "a_b_c", "a..b", "a/b", "../x",
		"abc\n", "abc def", strings.Repeat("a", 64)} {
		if err := S3Bucket(s); err == nil {
			t.Errorf("S3Bucket(%q) should be invalid", s)
		}
	}
}

func TestS3Region(t *testing.T) {
	for _, s := range []string{"auto", "eu-west-1", "us-east-1"} {
		if err := S3Region(s); err != nil {
			t.Errorf("S3Region(%q) should be valid: %v", s, err)
		}
	}
	for _, s := range []string{"", "a", "EU", "eu west", "eu/west", "-eu", "eu\n", strings.Repeat("a", 31)} {
		if err := S3Region(s); err == nil {
			t.Errorf("S3Region(%q) should be invalid", s)
		}
	}
}

func TestS3Keys(t *testing.T) {
	if err := S3AccessKey("AKIAIOSFODNN7EXAMPLE"); err != nil {
		t.Errorf("valid access key rejected: %v", err)
	}
	if err := S3SecretKey("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"); err != nil {
		t.Errorf("valid secret key rejected: %v", err)
	}
	for _, s := range []string{"", "short", "AKIA IOSFODNN7", "AKIA\nIOSFODNN7", "AKIA=IOSFODNN7;rm", strings.Repeat("A", 129)} {
		err := S3AccessKey(s)
		if err == nil {
			t.Errorf("S3AccessKey(%q) should be invalid", s)
		} else if s != "" && strings.Contains(err.Error(), s) {
			t.Errorf("S3AccessKey error echoes the value")
		}
	}
	for _, s := range []string{"", "short", "abc def ghi jkl mno pqr", "abc\ndef0123456789012", "abc;rm -rf /0123456789", strings.Repeat("A", 257)} {
		err := S3SecretKey(s)
		if err == nil {
			t.Errorf("S3SecretKey(%q) should be invalid", s)
		} else if s != "" && strings.Contains(err.Error(), s) {
			t.Errorf("S3SecretKey error echoes the value")
		}
	}
}
