package osutil

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"sync"
	"syscall"
)

type OSExecutor interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	RunAs(ctx context.Context, username string, name string, args ...string) ([]byte, error)
	// RunEnv runs name with extra KEY=VALUE environment entries added to the
	// agent's own environment. Use it to hand secrets to a child process
	// without exposing them in its argument list (visible in /proc/<pid>/cmdline).
	RunEnv(ctx context.Context, env []string, name string, args ...string) ([]byte, error)
	MkdirAll(path string, perm os.FileMode) error
	Chown(path string, uid, gid int) error
	WriteFile(path string, data []byte, perm os.FileMode) error
	ReadFile(path string) ([]byte, error)
	LookupUser(username string) (uid int, gid int, err error)
	// GroupName returns the name of the group with the given gid.
	GroupName(gid int) (string, error)
	// WriteFileAtomic writes data to a new file beside path, already owned by
	// uid:gid with mode perm before any data is written, then renames it over
	// path. It never follows symlinks and never reuses an existing inode, so a
	// descriptor opened on the previous file cannot read the new content.
	WriteFileAtomic(path string, data []byte, perm os.FileMode, uid, gid int) error
	// EnsureDir makes path a directory with the given mode and owner. It fails
	// if path exists and is not a real directory (e.g. a symlink).
	EnsureDir(path string, perm os.FileMode, uid, gid int) error
}

type RealExecutor struct{}

func (e *RealExecutor) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (e *RealExecutor) RunEnv(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	return cmd.CombinedOutput()
}

func (e *RealExecutor) RunAs(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
	cmdArgs := append([]string{"-u", username, "--", name}, args...)
	return exec.CommandContext(ctx, "/usr/sbin/runuser", cmdArgs...).CombinedOutput()
}

func (e *RealExecutor) MkdirAll(path string, perm os.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (e *RealExecutor) Chown(path string, uid, gid int) error {
	return os.Chown(path, uid, gid)
}

func (e *RealExecutor) WriteFile(path string, data []byte, perm os.FileMode) error {
	return os.WriteFile(path, data, perm)
}

func (e *RealExecutor) ReadFile(path string) ([]byte, error) {
	return os.ReadFile(path)
}

func (e *RealExecutor) LookupUser(username string) (int, int, error) {
	u, err := user.Lookup(username)
	if err != nil {
		return 0, 0, err
	}
	uid, err := strconv.Atoi(u.Uid)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid uid %q: %w", u.Uid, err)
	}
	gid, err := strconv.Atoi(u.Gid)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid gid %q: %w", u.Gid, err)
	}
	return uid, gid, nil
}

func (e *RealExecutor) GroupName(gid int) (string, error) {
	g, err := user.LookupGroupId(strconv.Itoa(gid))
	if err != nil {
		return "", err
	}
	return g.Name, nil
}

func (e *RealExecutor) WriteFileAtomic(path string, data []byte, perm os.FileMode, uid, gid int) (err error) {
	tmp := path + ".tmp"
	if rmErr := os.Remove(tmp); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
		return rmErr
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(tmp)
		}
	}()
	if err = f.Chown(uid, gid); err != nil {
		return err
	}
	if err = f.Chmod(perm); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (e *RealExecutor) EnsureDir(path string, perm os.FileMode, uid, gid int) error {
	fi, err := os.Lstat(path)
	switch {
	case err == nil:
		if !fi.IsDir() {
			return fmt.Errorf("%s exists and is not a directory", path)
		}
	case errors.Is(err, os.ErrNotExist):
		if err := os.MkdirAll(path, perm); err != nil {
			return err
		}
	default:
		return err
	}
	if err := os.Chmod(path, perm); err != nil {
		return err
	}
	return os.Chown(path, uid, gid)
}

type Call struct {
	Method string
	Args   []string
}

type FakeExecutor struct {
	mu    sync.Mutex
	Calls []Call
	// EnvCalls holds the env slice of each RunEnv call, in call order.
	EnvCalls [][]string

	RunFunc       func(ctx context.Context, name string, args ...string) ([]byte, error)
	RunEnvFunc    func(ctx context.Context, env []string, name string, args ...string) ([]byte, error)
	RunAsFunc     func(ctx context.Context, username string, name string, args ...string) ([]byte, error)
	LookupResult  map[string][2]int // username -> {uid, gid}
	GroupNames    map[int]string    // gid -> group name; default: the name of the user owning that gid
	ReadFileData  map[string][]byte
	WriteFileData map[string][]byte
	MkdirErr      error
	ChownErr      error
	WriteFileErr  error
}

func NewFakeExecutor() *FakeExecutor {
	return &FakeExecutor{
		LookupResult:  make(map[string][2]int),
		ReadFileData:  make(map[string][]byte),
		WriteFileData: make(map[string][]byte),
	}
}

func (f *FakeExecutor) record(method string, args ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, Call{Method: method, Args: args})
}

func (f *FakeExecutor) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	f.record("Run", append([]string{name}, args...)...)
	if f.RunFunc != nil {
		return f.RunFunc(ctx, name, args...)
	}
	return nil, nil
}

// RunEnv records the call as "RunEnv" with args [name, args...]; the env
// entries are recorded separately in EnvCalls so tests can assert that
// secrets never appear in the argument list.
func (f *FakeExecutor) RunEnv(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.record("RunEnv", append([]string{name}, args...)...)
	f.mu.Lock()
	f.EnvCalls = append(f.EnvCalls, append([]string{}, env...))
	f.mu.Unlock()
	if f.RunEnvFunc != nil {
		return f.RunEnvFunc(ctx, env, name, args...)
	}
	return nil, nil
}

func (f *FakeExecutor) RunAs(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
	f.record("RunAs", append([]string{username, name}, args...)...)
	if f.RunAsFunc != nil {
		return f.RunAsFunc(ctx, username, name, args...)
	}
	return nil, nil
}

func (f *FakeExecutor) MkdirAll(path string, perm os.FileMode) error {
	f.record("MkdirAll", path, fmt.Sprintf("%04o", perm))
	return f.MkdirErr
}

func (f *FakeExecutor) Chown(path string, uid, gid int) error {
	f.record("Chown", path, strconv.Itoa(uid), strconv.Itoa(gid))
	return f.ChownErr
}

func (f *FakeExecutor) WriteFile(path string, data []byte, perm os.FileMode) error {
	f.record("WriteFile", path)
	if f.WriteFileErr != nil {
		return f.WriteFileErr
	}
	f.mu.Lock()
	f.WriteFileData[path] = append([]byte{}, data...)
	f.mu.Unlock()
	return nil
}

func (f *FakeExecutor) ReadFile(path string) ([]byte, error) {
	f.record("ReadFile", path)
	f.mu.Lock()
	defer f.mu.Unlock()
	if data, ok := f.ReadFileData[path]; ok {
		return data, nil
	}
	if data, ok := f.WriteFileData[path]; ok {
		return data, nil
	}
	return nil, os.ErrNotExist
}

func (f *FakeExecutor) LookupUser(username string) (int, int, error) {
	f.record("LookupUser", username)
	f.mu.Lock()
	defer f.mu.Unlock()
	if ids, ok := f.LookupResult[username]; ok {
		return ids[0], ids[1], nil
	}
	return 0, 0, fmt.Errorf("user %q not found", username)
}

func (f *FakeExecutor) GroupName(gid int) (string, error) {
	f.record("GroupName", strconv.Itoa(gid))
	f.mu.Lock()
	defer f.mu.Unlock()
	if name, ok := f.GroupNames[gid]; ok {
		return name, nil
	}
	// Default: every account has a private group named after the user.
	for username, ids := range f.LookupResult {
		if ids[1] == gid {
			return username, nil
		}
	}
	return "", fmt.Errorf("group %d not found", gid)
}

func (f *FakeExecutor) WriteFileAtomic(path string, data []byte, perm os.FileMode, uid, gid int) error {
	f.record("WriteFileAtomic", path, fmt.Sprintf("%04o", perm), strconv.Itoa(uid), strconv.Itoa(gid))
	if f.WriteFileErr != nil {
		return f.WriteFileErr
	}
	f.mu.Lock()
	f.WriteFileData[path] = append([]byte{}, data...)
	f.mu.Unlock()
	return nil
}

func (f *FakeExecutor) EnsureDir(path string, perm os.FileMode, uid, gid int) error {
	f.record("EnsureDir", path, fmt.Sprintf("%04o", perm), strconv.Itoa(uid), strconv.Itoa(gid))
	return f.MkdirErr
}

func (f *FakeExecutor) CallsFor(method string) []Call {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result []Call
	for _, c := range f.Calls {
		if c.Method == method {
			result = append(result, c)
		}
	}
	return result
}
