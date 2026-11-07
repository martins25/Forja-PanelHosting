package validate

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var (
	ErrInvalid = errors.New("validation failed")

	slugRe         = regexp.MustCompile(`^[a-z][a-z0-9-]{2,30}$`)
	dbNameRe       = regexp.MustCompile(`^[a-z][a-z0-9_]{2,40}$`)
	gitBranchRe    = regexp.MustCompile(`^[A-Za-z0-9._/\-]{1,100}$`)
	repoURLRe      = regexp.MustCompile(`^https://([a-z0-9.-]+)(?::([0-9]{1,5}))?/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?$`)
	commitSHARe    = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
	nodeVersionRe   = regexp.MustCompile(`^(18|20|22|24)$`)
	phpVersionRe    = regexp.MustCompile(`^(8\.1|8\.2|8\.3|8\.4)$`)
	pythonVersionRe = regexp.MustCompile(`^(3\.11|3\.12|3\.13)$`)
	publicDirRe     = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$`)
	containerNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{2,80}$`)
	containerCmdRe  = regexp.MustCompile(`^[a-zA-Z0-9 _./:=@\-]{1,200}$`)
	envKeyRe       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	tunnelIDRe     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	cfAccountIDRe  = regexp.MustCompile(`^[0-9a-f]{32}$`)
	tunnelTokenRe      = regexp.MustCompile(`^[A-Za-z0-9+/=_-]+$`)
	cfAPITokenRe       = regexp.MustCompile(`^[A-Za-z0-9_-]{20,256}$`)
	resticSnapshotRe   = regexp.MustCompile(`^[0-9a-f]{8,64}$`)
	backupScopeRe      = regexp.MustCompile(`^(all|sites|databases)$`)
	restoreTargetRe    = regexp.MustCompile(`^(all|site:[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$`)
	exportTokenRe      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	numericLabelRe     = regexp.MustCompile(`^([0-9]+|0x[0-9a-f]*)$`)
)

func Slug(s string) error {
	if !slugRe.MatchString(s) {
		return fmt.Errorf("%w: invalid slug %q", ErrInvalid, s)
	}
	return nil
}

func Hostname(h string) error {
	if h == "" {
		return fmt.Errorf("%w: empty hostname", ErrInvalid)
	}
	lower := strings.ToLower(h)
	if lower != h {
		return fmt.Errorf("%w: hostname must be lowercase", ErrInvalid)
	}
	if strings.Contains(h, "*") {
		return fmt.Errorf("%w: wildcards not allowed", ErrInvalid)
	}
	if len(h) > 253 {
		return fmt.Errorf("%w: hostname too long", ErrInvalid)
	}
	labels := strings.Split(h, ".")
	if len(labels) < 2 {
		return fmt.Errorf("%w: hostname must have at least two labels", ErrInvalid)
	}
	for _, label := range labels {
		if err := validateLabel(label); err != nil {
			return fmt.Errorf("%w: %s", ErrInvalid, err)
		}
	}
	return nil
}

func validateLabel(label string) error {
	if len(label) == 0 || len(label) > 63 {
		return fmt.Errorf("label length must be 1-63, got %d", len(label))
	}
	for i, c := range label {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || (c == '-' && i > 0 && i < len(label)-1)) {
			return fmt.Errorf("invalid character %q in label %q", c, label)
		}
	}
	return nil
}

func DBName(n string) error {
	if !dbNameRe.MatchString(n) {
		return fmt.Errorf("%w: invalid database name %q", ErrInvalid, n)
	}
	return nil
}

func DBUser(u string) error {
	if !dbNameRe.MatchString(u) {
		return fmt.Errorf("%w: invalid database user %q", ErrInvalid, u)
	}
	return nil
}

func GitBranch(b string) error {
	if b == "" {
		return fmt.Errorf("%w: empty branch name", ErrInvalid)
	}
	if strings.HasPrefix(b, "-") {
		return fmt.Errorf("%w: branch must not start with '-'", ErrInvalid)
	}
	if strings.Contains(b, "..") {
		return fmt.Errorf("%w: branch must not contain '..'", ErrInvalid)
	}
	if !gitBranchRe.MatchString(b) {
		return fmt.Errorf("%w: invalid branch name %q", ErrInvalid, b)
	}
	return nil
}

// SafePath resolves path under baseDir, following symlinks, and verifies
// the result stays within baseDir. Returns the resolved absolute path.
func SafePath(baseDir, path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%w: empty path", ErrInvalid)
	}

	base, err := filepath.Abs(baseDir)
	if err != nil {
		return "", fmt.Errorf("%w: bad base dir: %s", ErrInvalid, err)
	}
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		return "", fmt.Errorf("%w: cannot resolve base dir: %s", ErrInvalid, err)
	}

	joined := filepath.Join(base, filepath.Clean(path))
	resolved, err := filepath.EvalSymlinks(joined)
	if err != nil {
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("%w: cannot resolve path: %s", ErrInvalid, err)
		}
		parent := filepath.Dir(joined)
		resolvedParent, err2 := filepath.EvalSymlinks(parent)
		if err2 != nil {
			return "", fmt.Errorf("%w: cannot resolve parent: %s", ErrInvalid, err2)
		}
		resolved = filepath.Join(resolvedParent, filepath.Base(joined))
	}

	if !strings.HasPrefix(resolved, base+string(filepath.Separator)) && resolved != base {
		return "", fmt.Errorf("%w: path escapes base directory", ErrInvalid)
	}

	return resolved, nil
}

// NoLeadingDash rejects any argument that starts with '-'.
func NoLeadingDash(arg string) error {
	if strings.HasPrefix(arg, "-") {
		return fmt.Errorf("%w: argument must not start with '-': %q", ErrInvalid, arg)
	}
	return nil
}

// Port validates that a string is a valid TCP port in the allowed range.
func Port(p int) error {
	if p < 1 || p > 65535 {
		return fmt.Errorf("%w: port out of range: %d", ErrInvalid, p)
	}
	return nil
}

// IPAddress validates an IPv4 or IPv6 address.
func IPAddress(s string) error {
	if net.ParseIP(s) == nil {
		return fmt.Errorf("%w: invalid IP address %q", ErrInvalid, s)
	}
	return nil
}

// RepoURL accepts https://<host>[:port]/<owner>/<repo>[.git] for GitHub and
// self-hosted Gitea instances. The host must be a public DNS name: IP
// literals and local-only suffixes are rejected so the agent cannot be
// pointed at internal services.
func RepoURL(u string) error {
	m := repoURLRe.FindStringSubmatch(u)
	if m == nil {
		return fmt.Errorf("%w: invalid repository URL %q", ErrInvalid, u)
	}
	host, port, owner, repo := m[1], m[2], m[3], m[4]
	if err := Hostname(host); err != nil || net.ParseIP(host) != nil {
		return fmt.Errorf("%w: invalid repository host %q", ErrInvalid, host)
	}
	// libcurl/git resolve "127.1", "0x7f.1" or "127.0.0.0x1" through inet_aton()
	// to 127.0.0.1 although net.ParseIP rejects them. A real public host never
	// has an all-numeric or hex-prefixed last label (RFC 3696, section 2).
	lastLabel := host[strings.LastIndex(host, ".")+1:]
	if numericLabelRe.MatchString(lastLabel) {
		return fmt.Errorf("%w: repository host %q looks like an IP address", ErrInvalid, host)
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".lan"} {
		if strings.HasSuffix(host, suffix) {
			return fmt.Errorf("%w: repository host %q is not public", ErrInvalid, host)
		}
	}
	if port != "" {
		if n, _ := strconv.Atoi(port); n < 1 || n > 65535 {
			return fmt.Errorf("%w: invalid repository port %q", ErrInvalid, port)
		}
	}
	for _, seg := range []string{owner, repo} {
		if seg == "." || seg == ".." {
			return fmt.Errorf("%w: invalid repository path %q", ErrInvalid, u)
		}
	}
	return nil
}

func CommitSHA(sha string) error {
	if !commitSHARe.MatchString(sha) {
		return fmt.Errorf("%w: invalid commit SHA %q", ErrInvalid, sha)
	}
	return nil
}

func NodeVersion(v string) error {
	if !nodeVersionRe.MatchString(v) {
		return fmt.Errorf("%w: unsupported Node version %q", ErrInvalid, v)
	}
	return nil
}

func PHPVersion(v string) error {
	if !phpVersionRe.MatchString(v) {
		return fmt.Errorf("%w: unsupported PHP version %q", ErrInvalid, v)
	}
	return nil
}

func PythonVersion(v string) error {
	if !pythonVersionRe.MatchString(v) {
		return fmt.Errorf("%w: unsupported Python version %q", ErrInvalid, v)
	}
	return nil
}

func RuntimeVersion(runtime, version string) error {
	switch runtime {
	case "node":
		return NodeVersion(version)
	case "php":
		return PHPVersion(version)
	case "python":
		return PythonVersion(version)
	case "static", "docker":
		if version != "" {
			return fmt.Errorf("%w: %s runtime does not use a version", ErrInvalid, runtime)
		}
		return nil
	default:
		return fmt.Errorf("%w: unsupported runtime %q", ErrInvalid, runtime)
	}
}

func PublicDir(dir string) error {
	if dir == "" {
		return nil
	}
	if strings.Contains(dir, "..") {
		return fmt.Errorf("%w: public_dir must not contain '..'", ErrInvalid)
	}
	if !publicDirRe.MatchString(dir) {
		return fmt.Errorf("%w: invalid public_dir %q", ErrInvalid, dir)
	}
	return nil
}

func ContainerName(name string) error {
	if name == "" {
		return nil
	}
	if !containerNameRe.MatchString(name) {
		return fmt.Errorf("%w: invalid container name %q", ErrInvalid, name)
	}
	return nil
}

func ContainerCmd(cmd string) error {
	if cmd == "" {
		return nil
	}
	if !containerCmdRe.MatchString(cmd) {
		return fmt.Errorf("%w: invalid container command %q", ErrInvalid, cmd)
	}
	return nil
}

func EnvKey(s string) error {
	if !envKeyRe.MatchString(s) {
		return fmt.Errorf("%w: invalid env key %q", ErrInvalid, s)
	}
	return nil
}

func EnvValue(s string) error {
	if len(s) > 8192 {
		return fmt.Errorf("%w: env value too long (%d bytes, max 8192)", ErrInvalid, len(s))
	}
	if strings.ContainsRune(s, '\x00') {
		return fmt.Errorf("%w: env value contains null byte", ErrInvalid)
	}
	if strings.ContainsAny(s, "\n\r") {
		return fmt.Errorf("%w: env value contains newline", ErrInvalid)
	}
	return nil
}

// DBPassword validates a database password (hex-only, as generated by the API).
// The value is never echoed in the error.
var dbPasswordRe = regexp.MustCompile(`^[A-Fa-f0-9]{8,128}$`)

func DBPassword(s string) error {
	if !dbPasswordRe.MatchString(s) {
		return fmt.Errorf("%w: invalid database password", ErrInvalid)
	}
	return nil
}

// DBEngine validates a database engine identifier.
func DBEngine(s string) error {
	switch s {
	case "mariadb", "mysql", "postgres":
		return nil
	default:
		return fmt.Errorf("%w: unsupported database engine %q", ErrInvalid, s)
	}
}

// WebTool validates a database web management tool identifier.
func WebTool(s string) error {
	switch s {
	case "phpmyadmin", "adminer", "pgadmin":
		return nil
	default:
		return fmt.Errorf("%w: unsupported web tool %q", ErrInvalid, s)
	}
}

// DomainSafe converts a validated hostname to a container-safe name.
func DomainSafe(domain string) string {
	return strings.ReplaceAll(domain, ".", "-")
}

// TunnelID validates a Cloudflare tunnel UUID (lowercase).
func TunnelID(s string) error {
	if !tunnelIDRe.MatchString(s) {
		return fmt.Errorf("%w: invalid tunnel id", ErrInvalid)
	}
	return nil
}

// CFAccountID validates a Cloudflare account identifier (32 hex chars).
func CFAccountID(s string) error {
	if !cfAccountIDRe.MatchString(s) {
		return fmt.Errorf("%w: invalid cloudflare account id", ErrInvalid)
	}
	return nil
}

// TunnelToken validates a cloudflared tunnel token (base64 payload).
// The value is never echoed in the error.
func TunnelToken(s string) error {
	if len(s) < 20 || len(s) > 2048 || !tunnelTokenRe.MatchString(s) {
		return fmt.Errorf("%w: invalid tunnel token", ErrInvalid)
	}
	return nil
}

// CFAPIToken validates a Cloudflare API token. The value is never echoed in the error.
func CFAPIToken(s string) error {
	if !cfAPITokenRe.MatchString(s) {
		return fmt.Errorf("%w: invalid cloudflare api token", ErrInvalid)
	}
	return nil
}

func ResticSnapshotID(s string) error {
	if !resticSnapshotRe.MatchString(s) {
		return fmt.Errorf("%w: invalid restic snapshot id", ErrInvalid)
	}
	return nil
}

func BackupScope(s string) error {
	if !backupScopeRe.MatchString(s) {
		return fmt.Errorf("%w: invalid backup scope, must be all|sites|databases", ErrInvalid)
	}
	return nil
}

func RestoreTarget(s string) error {
	if !restoreTargetRe.MatchString(s) {
		return fmt.Errorf("%w: invalid restore target, must be all|site:<domain>", ErrInvalid)
	}
	return nil
}

func ExportToken(s string) error {
	if !exportTokenRe.MatchString(s) {
		return fmt.Errorf("%w: invalid export token", ErrInvalid)
	}
	return nil
}

var (
	s3EndpointRe = regexp.MustCompile(`^https://([a-z0-9.-]+)(?::([0-9]{1,5}))?$`)
	s3BucketRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	s3RegionRe   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,29}$`)
	s3AccessRe   = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
	s3SecretRe   = regexp.MustCompile(`^[A-Za-z0-9/+=_.-]{16,256}$`)
)

// RemoteKind validates the kind of a remote backup backend.
func RemoteKind(s string) error {
	switch s {
	case "s3", "r2":
		return nil
	default:
		return fmt.Errorf("%w: unsupported remote kind %q", ErrInvalid, s)
	}
}

// S3Endpoint accepts https://<host>[:port] only (no path, query or userinfo).
// The host must be a public DNS name, as for RepoURL, so the agent cannot be
// pointed at internal services, and plain http is refused so credentials never
// travel in clear.
func S3Endpoint(u string) error {
	m := s3EndpointRe.FindStringSubmatch(u)
	if m == nil {
		return fmt.Errorf("%w: invalid S3 endpoint, expected https://host[:port]", ErrInvalid)
	}
	host, port := m[1], m[2]
	if err := Hostname(host); err != nil || net.ParseIP(host) != nil {
		return fmt.Errorf("%w: invalid S3 endpoint host %q", ErrInvalid, host)
	}
	lastLabel := host[strings.LastIndex(host, ".")+1:]
	if numericLabelRe.MatchString(lastLabel) {
		return fmt.Errorf("%w: S3 endpoint host %q looks like an IP address", ErrInvalid, host)
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".lan"} {
		if strings.HasSuffix(host, suffix) {
			return fmt.Errorf("%w: S3 endpoint host %q is not public", ErrInvalid, host)
		}
	}
	if port != "" {
		if n, _ := strconv.Atoi(port); n < 1 || n > 65535 {
			return fmt.Errorf("%w: invalid S3 endpoint port", ErrInvalid)
		}
	}
	return nil
}

// S3Bucket validates an S3 bucket name (3-63 chars, lowercase, no "..").
func S3Bucket(s string) error {
	if !s3BucketRe.MatchString(s) || strings.Contains(s, "..") {
		return fmt.Errorf("%w: invalid S3 bucket name", ErrInvalid)
	}
	return nil
}

// S3Region validates a region identifier ("auto" for Cloudflare R2).
func S3Region(s string) error {
	if !s3RegionRe.MatchString(s) {
		return fmt.Errorf("%w: invalid S3 region", ErrInvalid)
	}
	return nil
}

// S3AccessKey validates an access key id. The value is never echoed.
func S3AccessKey(s string) error {
	if !s3AccessRe.MatchString(s) {
		return fmt.Errorf("%w: invalid S3 access key", ErrInvalid)
	}
	return nil
}

// S3SecretKey validates a secret access key. The value is never echoed.
func S3SecretKey(s string) error {
	if !s3SecretRe.MatchString(s) {
		return fmt.Errorf("%w: invalid S3 secret key", ErrInvalid)
	}
	return nil
}
