package osutil

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
)

func TestFakeExecutor_Run(t *testing.T) {
	fake := NewFakeExecutor()
	out, err := fake.Run(context.Background(), "echo", "hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != nil {
		t.Fatalf("expected nil output, got %q", out)
	}

	calls := fake.CallsFor("Run")
	if len(calls) != 1 {
		t.Fatalf("expected 1 Run call, got %d", len(calls))
	}
	if calls[0].Args[0] != "echo" || calls[0].Args[1] != "hello" {
		t.Errorf("unexpected args: %v", calls[0].Args)
	}
}

func TestFakeExecutor_RunWithFunc(t *testing.T) {
	fake := NewFakeExecutor()
	fake.RunFunc = func(_ context.Context, name string, args ...string) ([]byte, error) {
		return []byte("output"), nil
	}

	out, err := fake.Run(context.Background(), "ls")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(out) != "output" {
		t.Errorf("expected %q, got %q", "output", string(out))
	}
}

func TestFakeExecutor_RunAs(t *testing.T) {
	fake := NewFakeExecutor()
	out, err := fake.RunAs(context.Background(), "testuser", "podman", "network", "create", "net0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out != nil {
		t.Fatalf("expected nil output, got %q", out)
	}

	calls := fake.CallsFor("RunAs")
	if len(calls) != 1 {
		t.Fatalf("expected 1 RunAs call, got %d", len(calls))
	}
	want := []string{"testuser", "podman", "network", "create", "net0"}
	for i, w := range want {
		if calls[0].Args[i] != w {
			t.Errorf("arg[%d]: want %q, got %q", i, w, calls[0].Args[i])
		}
	}
}

func TestFakeExecutor_RunAsWithFunc(t *testing.T) {
	fake := NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, username string, name string, args ...string) ([]byte, error) {
		return nil, fmt.Errorf("command failed")
	}

	_, err := fake.RunAs(context.Background(), "u", "bad")
	if err == nil || err.Error() != "command failed" {
		t.Errorf("expected 'command failed' error, got %v", err)
	}
}

func TestFakeExecutor_MkdirAll(t *testing.T) {
	fake := NewFakeExecutor()
	err := fake.MkdirAll("/srv/forja/accounts/demo/sites", 0750)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	calls := fake.CallsFor("MkdirAll")
	if len(calls) != 1 {
		t.Fatalf("expected 1 MkdirAll call, got %d", len(calls))
	}
	if calls[0].Args[0] != "/srv/forja/accounts/demo/sites" {
		t.Errorf("unexpected path: %s", calls[0].Args[0])
	}
	if calls[0].Args[1] != "0750" {
		t.Errorf("unexpected perm: %s", calls[0].Args[1])
	}
}

func TestFakeExecutor_Chown(t *testing.T) {
	fake := NewFakeExecutor()
	err := fake.Chown("/srv/forja/accounts/demo", 1001, 1001)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	calls := fake.CallsFor("Chown")
	if len(calls) != 1 {
		t.Fatalf("expected 1 Chown call, got %d", len(calls))
	}
	if calls[0].Args[0] != "/srv/forja/accounts/demo" {
		t.Errorf("unexpected path: %s", calls[0].Args[0])
	}
	if calls[0].Args[1] != "1001" || calls[0].Args[2] != "1001" {
		t.Errorf("unexpected uid/gid: %s %s", calls[0].Args[1], calls[0].Args[2])
	}
}

func TestFakeExecutor_WriteAndReadFile(t *testing.T) {
	fake := NewFakeExecutor()

	err := fake.WriteFile("/tmp/test.txt", []byte("content"), 0644)
	if err != nil {
		t.Fatalf("WriteFile error: %v", err)
	}

	data, err := fake.ReadFile("/tmp/test.txt")
	if err != nil {
		t.Fatalf("ReadFile error: %v", err)
	}
	if string(data) != "content" {
		t.Errorf("expected %q, got %q", "content", string(data))
	}
}

func TestFakeExecutor_ReadFileNotFound(t *testing.T) {
	fake := NewFakeExecutor()
	_, err := fake.ReadFile("/nonexistent")
	if !errors.Is(err, os.ErrNotExist) {
		t.Errorf("expected os.ErrNotExist, got %v", err)
	}
}

func TestFakeExecutor_ReadFilePreloaded(t *testing.T) {
	fake := NewFakeExecutor()
	fake.ReadFileData["/etc/subuid"] = []byte("existing:100000:65536\n")

	data, err := fake.ReadFile("/etc/subuid")
	if err != nil {
		t.Fatalf("ReadFile error: %v", err)
	}
	if string(data) != "existing:100000:65536\n" {
		t.Errorf("unexpected data: %s", string(data))
	}
}

func TestFakeExecutor_LookupUser(t *testing.T) {
	fake := NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}

	uid, gid, err := fake.LookupUser("fj-demo")
	if err != nil {
		t.Fatalf("LookupUser error: %v", err)
	}
	if uid != 1001 || gid != 1001 {
		t.Errorf("expected uid=1001 gid=1001, got uid=%d gid=%d", uid, gid)
	}
}

func TestFakeExecutor_LookupUserNotFound(t *testing.T) {
	fake := NewFakeExecutor()
	_, _, err := fake.LookupUser("nobody-fake")
	if err == nil {
		t.Fatal("expected error for unknown user")
	}
}

func TestFakeExecutor_CallsFor(t *testing.T) {
	fake := NewFakeExecutor()
	fake.Run(context.Background(), "a")
	fake.Run(context.Background(), "b")
	fake.MkdirAll("/x", 0755)
	fake.Run(context.Background(), "c")

	if n := len(fake.CallsFor("Run")); n != 3 {
		t.Errorf("expected 3 Run calls, got %d", n)
	}
	if n := len(fake.CallsFor("MkdirAll")); n != 1 {
		t.Errorf("expected 1 MkdirAll call, got %d", n)
	}
	if n := len(fake.CallsFor("Chown")); n != 0 {
		t.Errorf("expected 0 Chown calls, got %d", n)
	}
}

func TestRealExecutor_ImplementsInterface(t *testing.T) {
	var _ OSExecutor = &RealExecutor{}
}

func TestFakeExecutor_ImplementsInterface(t *testing.T) {
	var _ OSExecutor = &FakeExecutor{}
}

func TestRealExecutor_WriteFileAtomic_NewInodeAndMode(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/token.env"
	e := &RealExecutor{}

	if err := e.WriteFileAtomic(path, []byte("one"), 0o640, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	// A descriptor opened on the old file, as a previous account could hold.
	old, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer old.Close()

	if err := e.WriteFileAtomic(path, []byte("two-secret"), 0o640, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}

	got, _ := os.ReadFile(path)
	if string(got) != "two-secret" {
		t.Errorf("content = %q", got)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o640 {
		t.Errorf("mode = %v", fi.Mode().Perm())
	}
	buf := make([]byte, 64)
	n, _ := old.Read(buf)
	if string(buf[:n]) != "one" {
		t.Errorf("old descriptor must keep seeing the old inode, got %q", buf[:n])
	}
	if _, err := os.Stat(path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Error("temporary file must not be left behind")
	}
}

func TestRealExecutor_WriteFileAtomic_DoesNotFollowSymlinks(t *testing.T) {
	dir := t.TempDir()
	victim := dir + "/victim"
	if err := os.WriteFile(victim, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := dir + "/token.env"
	// A planted symlink at the final path is replaced, never written through.
	if err := os.Symlink(victim, path); err != nil {
		t.Fatal(err)
	}
	e := &RealExecutor{}
	if err := e.WriteFileAtomic(path, []byte("secret"), 0o640, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(victim); string(got) != "keep" {
		t.Errorf("symlink target was modified: %q", got)
	}
	if fi, _ := os.Lstat(path); fi.Mode()&os.ModeSymlink != 0 {
		t.Error("final path should be a regular file")
	}

	// A planted symlink at the temporary path is removed first, not followed.
	if err := os.Symlink(victim, path+".tmp"); err != nil {
		t.Fatal(err)
	}
	if err := e.WriteFileAtomic(path, []byte("secret2"), 0o640, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(victim); string(got) != "keep" {
		t.Errorf("symlink target was modified via .tmp: %q", got)
	}
}

func TestRealExecutor_EnsureDir(t *testing.T) {
	base := t.TempDir()
	e := &RealExecutor{}

	dir := base + "/new"
	if err := e.EnsureDir(dir, 0o711, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	// Existing directory with wrong mode is corrected.
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.EnsureDir(dir, 0o711, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o711 {
		t.Errorf("mode = %v, want 0711", fi.Mode().Perm())
	}

	// A symlink, even to a directory, is refused.
	link := base + "/link"
	if err := os.Symlink(base, link); err != nil {
		t.Fatal(err)
	}
	if err := e.EnsureDir(link, 0o711, os.Getuid(), os.Getgid()); err == nil {
		t.Error("EnsureDir must refuse a symlink")
	}
	// A regular file is refused.
	file := base + "/file"
	os.WriteFile(file, nil, 0o600)
	if err := e.EnsureDir(file, 0o711, os.Getuid(), os.Getgid()); err == nil {
		t.Error("EnsureDir must refuse a regular file")
	}
}
