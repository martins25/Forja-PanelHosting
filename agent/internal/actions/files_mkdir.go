package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type FilesMkdir struct {
	OS       osutil.OSExecutor
	BasePath string
}

type FilesMkdirParams struct {
	AccountSlug string `json:"account_slug"`
	Path        string `json:"path"`
}

type FilesMkdirResult struct {
	Path string `json:"path"`
}

func (a *FilesMkdir) Name() string { return "files.mkdir" }

func (a *FilesMkdir) Validate(params json.RawMessage) error {
	var p FilesMkdirParams
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

func (a *FilesMkdir) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesMkdirParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	if _, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/mkdir", "-p", resolved); err != nil {
		return nil, fmt.Errorf("create directory: %w", err)
	}

	return &FilesMkdirResult{
		Path: p.Path,
	}, nil
}
