package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type FilesWrite struct {
	OS       osutil.OSExecutor
	BasePath string
}

type FilesWriteParams struct {
	AccountSlug string `json:"account_slug"`
	Path        string `json:"path"`
	Content     string `json:"content"`
}

type FilesWriteResult struct {
	Path string `json:"path"`
	Size int    `json:"size"`
}

func (a *FilesWrite) Name() string { return "files.write" }

const maxWriteSize = 5 * 1024 * 1024 // 5 MB

func (a *FilesWrite) Validate(params json.RawMessage) error {
	var p FilesWriteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if p.Path == "" {
		return fmt.Errorf("%w: path is required", validate.ErrInvalid)
	}
	if len(p.Content) > maxWriteSize {
		return fmt.Errorf("%w: content too large: %d bytes (limit %d)", validate.ErrInvalid, len(p.Content), maxWriteSize)
	}
	return nil
}

func (a *FilesWrite) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesWriteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	linuxUser := linuxUserPfx + p.AccountSlug

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	uid, gid, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("lookup user: %w", err)
	}

	parentDir := filepath.Dir(resolved)
	if _, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/mkdir", "-p", parentDir); err != nil {
		return nil, fmt.Errorf("create parent directory: %w", err)
	}

	data := []byte(p.Content)
	if err := a.OS.WriteFileAtomic(resolved, data, os.FileMode(0644), uid, gid); err != nil {
		return nil, fmt.Errorf("write file: %w", err)
	}
	if err := verifyWrittenInHome(ctx, a.OS, homeDir, resolved); err != nil {
		return nil, err
	}

	return &FilesWriteResult{
		Path: p.Path,
		Size: len(data),
	}, nil
}

// verifyWrittenInHome closes the TOCTOU window between SafePath and the rename
// done as root: after writing, the final location is resolved again (symlinks
// included) and must still be inside homeDir. If a parent directory was swapped
// for a symlink in between, the file just written is removed and an error is
// returned.
func verifyWrittenInHome(ctx context.Context, exec osutil.OSExecutor, homeDir, written string) error {
	base, err := filepath.EvalSymlinks(homeDir)
	if err != nil {
		return fmt.Errorf("verify written file: %w", err)
	}
	final, err := filepath.EvalSymlinks(written)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// Nothing at the path (e.g. removed concurrently): nothing escaped.
			return nil
		}
		return fmt.Errorf("verify written file: %w", err)
	}
	if final == base || strings.HasPrefix(final, base+string(filepath.Separator)) {
		return nil
	}
	// Remove the file that was written at its real location (as root; the
	// path is a regular file we just created, never followed through a link).
	_, _ = exec.Run(ctx, "/usr/bin/rm", "-f", "--", final)
	return fmt.Errorf("%w: path escapes home directory", validate.ErrInvalid)
}
