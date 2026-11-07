package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const maxUploadSize = 10 * 1024 * 1024 // 10 MB

type FilesUpload struct {
	OS       osutil.OSExecutor
	BasePath string
}

type FilesUploadParams struct {
	AccountSlug   string `json:"account_slug"`
	Path          string `json:"path"`
	ContentBase64 string `json:"content_base64"`
}

type FilesUploadResult struct {
	Path string `json:"path"`
	Size int    `json:"size"`
}

func (a *FilesUpload) Name() string { return "files.upload" }

func (a *FilesUpload) Validate(params json.RawMessage) error {
	var p FilesUploadParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if p.Path == "" {
		return fmt.Errorf("%w: path is required", validate.ErrInvalid)
	}
	if p.ContentBase64 == "" {
		return fmt.Errorf("%w: content_base64 is required", validate.ErrInvalid)
	}
	decoded, err := base64.StdEncoding.DecodeString(p.ContentBase64)
	if err != nil {
		return fmt.Errorf("%w: invalid base64 content", validate.ErrInvalid)
	}
	if len(decoded) > maxUploadSize {
		return fmt.Errorf("%w: file too large: %d bytes (limit %d)", validate.ErrInvalid, len(decoded), maxUploadSize)
	}
	return nil
}

func (a *FilesUpload) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesUploadParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	linuxUser := linuxUserPfx + p.AccountSlug

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	data, err := base64.StdEncoding.DecodeString(p.ContentBase64)
	if err != nil {
		return nil, fmt.Errorf("decode base64: %w", err)
	}

	uid, gid, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("lookup user: %w", err)
	}

	parentDir := filepath.Dir(resolved)
	if _, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/mkdir", "-p", parentDir); err != nil {
		return nil, fmt.Errorf("create parent directory: %w", err)
	}

	if err := a.OS.WriteFileAtomic(resolved, data, os.FileMode(0644), uid, gid); err != nil {
		return nil, fmt.Errorf("write file: %w", err)
	}
	if err := verifyWrittenInHome(ctx, a.OS, homeDir, resolved); err != nil {
		return nil, err
	}

	return &FilesUploadResult{
		Path: p.Path,
		Size: len(data),
	}, nil
}
