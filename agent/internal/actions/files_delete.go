package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type FilesDelete struct {
	OS       osutil.OSExecutor
	BasePath string
}

type FilesDeleteParams struct {
	AccountSlug string `json:"account_slug"`
	Path        string `json:"path"`
	Recursive   bool   `json:"recursive"`
}

type FilesDeleteResult struct {
	Path string `json:"path"`
}

func (a *FilesDelete) Name() string { return "files.delete" }

func (a *FilesDelete) Validate(params json.RawMessage) error {
	var p FilesDeleteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if p.Path == "" {
		return fmt.Errorf("%w: path is required", validate.ErrInvalid)
	}
	return nil
}

func (a *FilesDelete) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesDeleteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	if resolved == homeDir {
		return nil, fmt.Errorf("cannot delete account home directory")
	}

	var args []string
	if p.Recursive {
		args = []string{"-rf", "--", resolved}
	} else {
		args = []string{"-f", "--", resolved}
	}

	if _, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/rm", args...); err != nil {
		return nil, fmt.Errorf("delete: %w", err)
	}

	return &FilesDeleteResult{
		Path: p.Path,
	}, nil
}
