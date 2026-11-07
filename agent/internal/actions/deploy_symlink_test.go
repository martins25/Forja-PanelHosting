package actions

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/m4rtins/forja/agent/internal/health"
	"github.com/m4rtins/forja/agent/internal/osutil"
)

// realFSExecutor records every call like FakeExecutor but performs the file
// operations for real, with the semantics of the root agent: WriteFile follows
// symlinks (os.WriteFile), WriteFileAtomic and EnsureDir use the production
// implementation. Ownership is forced to the test user so it runs unprivileged.
type realFSExecutor struct {
	*osutil.FakeExecutor
	real osutil.RealExecutor
}

func newRealFSExecutor() *realFSExecutor {
	f := osutil.NewFakeExecutor()
	f.LookupResult["fj-demo"] = [2]int{os.Getuid(), os.Getgid()}
	return &realFSExecutor{FakeExecutor: f}
}

func (e *realFSExecutor) WriteFile(path string, data []byte, perm os.FileMode) error {
	_ = e.FakeExecutor.WriteFile(path, data, perm)
	return e.real.WriteFile(path, data, perm)
}

func (e *realFSExecutor) WriteFileAtomic(path string, data []byte, perm os.FileMode, uid, gid int) error {
	_ = e.FakeExecutor.WriteFileAtomic(path, data, perm, uid, gid)
	return e.real.WriteFileAtomic(path, data, perm, os.Getuid(), os.Getgid())
}

func (e *realFSExecutor) EnsureDir(path string, perm os.FileMode, uid, gid int) error {
	_ = e.FakeExecutor.EnsureDir(path, perm, uid, gid)
	return e.real.EnsureDir(path, perm, os.Getuid(), os.Getgid())
}

func (e *realFSExecutor) MkdirAll(path string, perm os.FileMode) error {
	_ = e.FakeExecutor.MkdirAll(path, perm)
	return e.real.MkdirAll(path, perm)
}

// deployFixture builds <base>/demo/{sites/example.com,backups} on disk plus a
// separate directory outside the account home that the attacker wants to reach.
type deployFixture struct {
	base    string
	home    string
	siteDir string
	outside string
}

func newDeployFixture(t *testing.T) *deployFixture {
	t.Helper()
	base := t.TempDir()
	f := &deployFixture{
		base:    base,
		home:    filepath.Join(base, "demo"),
		siteDir: filepath.Join(base, "demo", "sites", "example.com"),
		outside: t.TempDir(),
	}
	for _, d := range []string{f.siteDir, filepath.Join(f.home, "backups")} {
		if err := os.MkdirAll(d, 0o750); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func (f *deployFixture) symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

// replaceSiteDirWithSymlink swaps sites/example.com for a link to outside, as
// an account could do since it owns the sites directory.
func (f *deployFixture) replaceSiteDirWithSymlink(t *testing.T) {
	t.Helper()
	if err := os.RemoveAll(f.siteDir); err != nil {
		t.Fatal(err)
	}
	f.symlink(t, f.outside, f.siteDir)
}

// assertOutsideUntouched fails if anything was created in, or changed under,
// the outside directory. want maps file names to their expected (original)
// content; any other entry is a file root created out of the home.
func assertOutsideUntouched(t *testing.T, outside string, want map[string]string) {
	t.Helper()
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		orig, ok := want[e.Name()]
		if !ok {
			t.Errorf("root created %q outside the account home", filepath.Join(outside, e.Name()))
			continue
		}
		got, err := os.ReadFile(filepath.Join(outside, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != orig {
			t.Errorf("file outside the account home was modified: %q now has %q", e.Name(), got)
		}
	}
	for name := range want {
		if _, err := os.Stat(filepath.Join(outside, name)); err != nil {
			t.Errorf("file outside the account home disappeared: %s", name)
		}
	}
}

// assertNoWriteOutsideHome fails if any recorded WriteFile/WriteFileAtomic ended
// up (symlinks resolved, atomic writes replace a final symlink in place) outside
// the account home.
func assertNoWriteOutsideHome(t *testing.T, fake *osutil.FakeExecutor, home string) {
	t.Helper()
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{"WriteFile", "WriteFileAtomic"} {
		for _, c := range fake.CallsFor(method) {
			path := c.Args[0]
			dir, err := filepath.EvalSymlinks(filepath.Dir(path))
			if err != nil {
				continue // parent does not exist: nothing can be written there
			}
			if dir != realHome && !strings.HasPrefix(dir, realHome+string(filepath.Separator)) {
				t.Errorf("%s targeted %s, which lands outside the account home", method, path)
			}
		}
	}
}

func runDeploy(t *testing.T, fx *deployFixture, ex osutil.OSExecutor, mutate func(*SiteDeployParams)) error {
	t.Helper()
	p := validDeployParams()
	if mutate != nil {
		mutate(&p)
	}
	params, _ := json.Marshal(p)
	a := &SiteDeploy{OS: ex, Health: &health.FakeChecker{}, BasePath: fx.base}
	_, err := a.Execute(context.Background(), params)
	return err
}

func TestSiteDeploy_SymlinkEnvFile(t *testing.T) {
	fx := newDeployFixture(t)
	victim := filepath.Join(fx.outside, "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.symlink(t, victim, filepath.Join(fx.siteDir, ".env"))

	ex := newRealFSExecutor()
	if err := runDeploy(t, fx, ex, nil); err != nil {
		t.Fatalf("deploy should succeed by replacing the link: %v", err)
	}

	assertOutsideUntouched(t, fx.outside, map[string]string{"victim": "precious"})
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)

	fi, err := os.Lstat(filepath.Join(fx.siteDir, ".env"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		t.Error(".env must be a regular file after the deploy, not the planted symlink")
	}
}

func TestSiteDeploy_SymlinkContainerfile(t *testing.T) {
	fx := newDeployFixture(t)
	victim := filepath.Join(fx.outside, "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.symlink(t, victim, filepath.Join(fx.siteDir, "Containerfile"))

	ex := newRealFSExecutor()
	if err := runDeploy(t, fx, ex, nil); err != nil {
		t.Fatalf("deploy should succeed by replacing the link: %v", err)
	}

	assertOutsideUntouched(t, fx.outside, map[string]string{"victim": "precious"})
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
}

func TestSiteDeploy_SymlinkBuildLog(t *testing.T) {
	fx := newDeployFixture(t)
	logsDir := filepath.Join(fx.siteDir, "logs")
	if err := os.MkdirAll(logsDir, 0o750); err != nil {
		t.Fatal(err)
	}
	victim := filepath.Join(fx.outside, "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The log name is deploy-<UTC timestamp>.log, predictable to the second:
	// plant a link for every second the deploy can land on.
	now := time.Now().UTC()
	for i := -1; i <= 5; i++ {
		name := "deploy-" + now.Add(time.Duration(i)*time.Second).Format("20060102-150405") + ".log"
		fx.symlink(t, victim, filepath.Join(logsDir, name))
	}

	ex := newRealFSExecutor()
	if err := runDeploy(t, fx, ex, nil); err != nil {
		t.Fatalf("deploy should succeed: %v", err)
	}

	assertOutsideUntouched(t, fx.outside, map[string]string{"victim": "precious"})
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
}

func TestSiteDeploy_SymlinkLogsDir(t *testing.T) {
	fx := newDeployFixture(t)
	fx.symlink(t, fx.outside, filepath.Join(fx.siteDir, "logs"))

	ex := newRealFSExecutor()
	_ = runDeploy(t, fx, ex, nil) // refusing or skipping the log are both fine

	assertOutsideUntouched(t, fx.outside, nil)
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
}

func TestSiteDeploy_SiteDirIsSymlink(t *testing.T) {
	for _, runtime := range []string{"node", "docker"} {
		t.Run(runtime, func(t *testing.T) {
			fx := newDeployFixture(t)
			fx.replaceSiteDirWithSymlink(t)

			ex := newRealFSExecutor()
			err := runDeploy(t, fx, ex, func(p *SiteDeployParams) { p.Runtime = runtime })
			if err == nil {
				t.Error("deploy must refuse a site directory that is a symlink")
			}

			assertOutsideUntouched(t, fx.outside, nil)
			assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
			if got := ex.CallsFor("Chown"); len(got) > 0 {
				for _, c := range got {
					if strings.HasPrefix(c.Args[0], fx.outside) {
						t.Errorf("Chown reached outside the home: %s", c.Args[0])
					}
				}
			}
		})
	}
}

func TestDBDump_SymlinkDumpFile(t *testing.T) {
	fx := newDeployFixture(t)
	backups := filepath.Join(fx.home, "backups")
	victim := filepath.Join(fx.outside, "victim")
	if err := os.WriteFile(victim, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for i := -1; i <= 5; i++ {
		name := "db-mydb-" + now.Add(time.Duration(i)*time.Second).Format("20060102-150405") + ".sql"
		fx.symlink(t, victim, filepath.Join(backups, name))
	}

	ex := newRealFSExecutor()
	ex.RunAsFunc = func(ctx context.Context, user, name string, args ...string) ([]byte, error) {
		return []byte("-- dump"), nil
	}
	a := &DBDump{OS: ex, BasePath: fx.base}
	params, _ := json.Marshal(validDBDumpParams())
	if _, err := a.Execute(context.Background(), params); err != nil {
		t.Fatalf("dump should succeed by replacing the link: %v", err)
	}

	assertOutsideUntouched(t, fx.outside, map[string]string{"victim": "precious"})
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
}

func TestDBDump_BackupsDirIsSymlink(t *testing.T) {
	fx := newDeployFixture(t)
	backups := filepath.Join(fx.home, "backups")
	if err := os.Remove(backups); err != nil {
		t.Fatal(err)
	}
	fx.symlink(t, fx.outside, backups)

	ex := newRealFSExecutor()
	ex.RunAsFunc = func(ctx context.Context, user, name string, args ...string) ([]byte, error) {
		return []byte("-- dump"), nil
	}
	a := &DBDump{OS: ex, BasePath: fx.base}
	params, _ := json.Marshal(validDBDumpParams())
	if _, err := a.Execute(context.Background(), params); err == nil {
		t.Error("dump must refuse a backups directory that is a symlink")
	}

	assertOutsideUntouched(t, fx.outside, nil)
	assertNoWriteOutsideHome(t, ex.FakeExecutor, fx.home)
}
