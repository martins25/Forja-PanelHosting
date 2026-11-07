package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestLogsTail_Name(t *testing.T) {
	a := &LogsTail{OS: &osutil.FakeExecutor{}}
	if a.Name() != "logs.tail" {
		t.Errorf("expected logs.tail, got %s", a.Name())
	}
}

func TestLogsTail_Validate_OK(t *testing.T) {
	a := &LogsTail{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "app",
		Lines:       100,
	})
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestLogsTail_Validate_InvalidSource(t *testing.T) {
	a := &LogsTail{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "invalid",
		Lines:       100,
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid source")
	}
}

func TestLogsTail_Validate_BuildRequiresLogPath(t *testing.T) {
	a := &LogsTail{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "build",
		Lines:       100,
		LogPath:     "",
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for build without log_path")
	}
}

func TestLogsTail_Validate_LinesRange(t *testing.T) {
	a := &LogsTail{OS: &osutil.FakeExecutor{}}
	for _, lines := range []int{0, -1, 1001} {
		params, _ := json.Marshal(LogsTailParams{
			AccountSlug: "demo",
			Domain:      "example.com",
			Source:      "app",
			Lines:       lines,
		})
		if err := a.Validate(params); err == nil {
			t.Errorf("expected error for lines=%d", lines)
		}
	}
}

func TestLogsTail_Execute_AppLogs(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		allArgs := append([]string{name}, args...)
		full := strings.Join(allArgs, " ")
		if strings.Contains(full, "podman ps") {
			return []byte("abc123\n"), nil
		}
		if strings.Contains(full, "podman logs") {
			return []byte("line1\nline2\nline3\n"), nil
		}
		return nil, nil
	}

	a := &LogsTail{OS: fake}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "app",
		Lines:       100,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*LogsTailResult)
	if r.Count != 3 {
		t.Errorf("expected 3 lines, got %d", r.Count)
	}
	if r.Source != "app" {
		t.Errorf("expected source=app, got %s", r.Source)
	}
	if r.Lines[0] != "line1" || r.Lines[2] != "line3" {
		t.Errorf("unexpected lines: %v", r.Lines)
	}
}

func TestLogsTail_Execute_AppNoContainer(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		allArgs := append([]string{name}, args...)
		full := strings.Join(allArgs, " ")
		if strings.Contains(full, "podman ps") {
			return []byte(""), nil
		}
		return nil, nil
	}

	a := &LogsTail{OS: fake}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "app",
		Lines:       100,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*LogsTailResult)
	if r.Count != 0 {
		t.Errorf("expected 0 lines for no container, got %d", r.Count)
	}
}

func newBuildLogFixture(t *testing.T) (base, logsDir string) {
	t.Helper()
	base = t.TempDir()
	logsDir = filepath.Join(base, "demo", "sites", "example.com", "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	return base, logsDir
}

// catAsFake simulates `cat <path>` run as the account user.
func catAsFake(fake *osutil.FakeExecutor) {
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		if name != "/usr/bin/cat" || len(args) != 1 {
			return nil, fmt.Errorf("unexpected command %s %v", name, args)
		}
		return os.ReadFile(args[0])
	}
}

func TestLogsTail_Execute_BuildLogs(t *testing.T) {
	base, logsDir := newBuildLogFixture(t)
	logContent := "=== git clone ===\nCloning...\n=== podman build ===\nBuilding...\nDone.\n"
	logPath := filepath.Join(logsDir, "deploy-20261101-120000.log")
	if err := os.WriteFile(logPath, []byte(logContent), 0o644); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	catAsFake(fake)
	a := &LogsTail{OS: fake, BasePath: base}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "build",
		Lines:       100,
		LogPath:     logPath,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*LogsTailResult)
	if r.Count != 5 {
		t.Errorf("expected 5 lines, got %d", r.Count)
	}
	if r.Lines[0] != "=== git clone ===" {
		t.Errorf("unexpected first line: %s", r.Lines[0])
	}
	// Must be read as the account user via RunAs, never as root via ReadFile.
	var asUser bool
	for _, c := range fake.Calls {
		if c.Method == "ReadFile" {
			t.Errorf("build log must not be read directly as root: %v", c)
		}
		if c.Method == "RunAs" && c.Args[0] == "fj-demo" {
			asUser = true
		}
	}
	if !asUser {
		t.Error("expected build log to be read via RunAs as the account user")
	}
}

func TestLogsTail_Execute_BuildLogs_SymlinkEscape(t *testing.T) {
	base, logsDir := newBuildLogFixture(t)
	secret := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(secret, []byte("root-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(logsDir, "evil.log")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	catAsFake(fake)
	a := &LogsTail{OS: fake, BasePath: base}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "build",
		Lines:       100,
		LogPath:     link,
	})

	if _, err := a.Execute(context.Background(), params); err == nil {
		t.Fatal("expected symlink escaping logs dir to be rejected")
	}
	if len(fake.Calls) != 0 {
		t.Errorf("nothing must be read for an escaping symlink, got calls: %v", fake.Calls)
	}
}

func TestLogsTail_Execute_BuildLogs_SymlinkedDirEscape(t *testing.T) {
	base, logsDir := newBuildLogFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "x.log"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(logsDir, "sub")); err != nil {
		t.Fatal(err)
	}

	fake := osutil.NewFakeExecutor()
	catAsFake(fake)
	a := &LogsTail{OS: fake, BasePath: base}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "build",
		Lines:       100,
		LogPath:     filepath.Join(logsDir, "sub", "x.log"),
	})
	if _, err := a.Execute(context.Background(), params); err == nil {
		t.Fatal("expected path through symlinked dir to be rejected")
	}
}

func TestLogsTail_Execute_BuildLogs_Traversal(t *testing.T) {
	base, logsDir := newBuildLogFixture(t)
	fake := osutil.NewFakeExecutor()
	catAsFake(fake)
	a := &LogsTail{OS: fake, BasePath: base}
	for _, lp := range []string{
		filepath.Join(logsDir, "..", "..", "..", "..", "etc", "passwd"),
		"/etc/passwd",
		"../../../../../etc/passwd",
	} {
		params, _ := json.Marshal(LogsTailParams{
			AccountSlug: "demo", Domain: "example.com", Source: "build", Lines: 10, LogPath: lp,
		})
		if _, err := a.Execute(context.Background(), params); err == nil {
			t.Errorf("expected %q to be rejected", lp)
		}
	}
	if len(fake.Calls) != 0 {
		t.Errorf("no command should run for rejected paths: %v", fake.Calls)
	}
}

func TestLogsTail_Execute_AccessLogs(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	accessContent := "{\"status\":200,\"path\":\"/\"}\n{\"status\":404,\"path\":\"/missing\"}"
	fake.ReadFileData["/srv/forja/accounts/demo/logs/access.log"] = []byte(accessContent)

	a := &LogsTail{OS: fake}
	params, _ := json.Marshal(LogsTailParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Source:      "access",
		Lines:       100,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*LogsTailResult)
	if r.Count != 2 {
		t.Errorf("expected 2 lines, got %d", r.Count)
	}
}

func TestSplitLines_TailLimit(t *testing.T) {
	input := "a\nb\nc\nd\ne"
	lines := splitLines(input, 3)
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if lines[0] != "c" || lines[1] != "d" || lines[2] != "e" {
		t.Errorf("unexpected lines: %v", lines)
	}
}

func TestSplitLines_Empty(t *testing.T) {
	lines := splitLines("", 10)
	if len(lines) != 0 {
		t.Errorf("expected 0 lines, got %d", len(lines))
	}
}
