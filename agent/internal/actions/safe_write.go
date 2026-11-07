package actions

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

// requireRealDirInHome checks that dir is a real directory (not a symlink)
// whose fully resolved location is inside homeDir. Use it before any
// privileged operation in a directory the account can modify: the account may
// replace such a directory with a symlink to anywhere (e.g. /etc).
//
// A missing dir, or a missing home, is not an error here: nothing on disk can
// redirect the operation, which then fails on its own (and verifyWrittenInHome
// re-checks the result after writing).
func requireRealDirInHome(homeDir, dir string) error {
	base, err := filepath.EvalSymlinks(homeDir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("resolve home: %w", err)
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", dir, err)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%w: %s is not a real directory", validate.ErrInvalid, dir)
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", dir, err)
	}
	if real != base && !strings.HasPrefix(real, base+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s escapes the account home", validate.ErrInvalid, dir)
	}
	return nil
}

// writeFileInHome writes a file as root into a directory the account owns,
// without ever following a symlink planted by the account:
//   - the parent directory must be a real directory inside homeDir;
//   - the content goes to a fresh temp file that is renamed over path, so a
//     symlink already at path is replaced, never written through;
//   - the final location is verified again to close the race on the parent.
func writeFileInHome(ctx context.Context, exec osutil.OSExecutor, homeDir, path string, data []byte, perm os.FileMode, uid, gid int) error {
	if err := requireRealDirInHome(homeDir, filepath.Dir(path)); err != nil {
		return err
	}
	if err := exec.WriteFileAtomic(path, data, perm, uid, gid); err != nil {
		return err
	}
	if _, err := filepath.EvalSymlinks(homeDir); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return verifyWrittenInHome(ctx, exec, homeDir, path)
}
