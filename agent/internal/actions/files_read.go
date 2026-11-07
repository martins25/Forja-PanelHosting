package actions

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const maxReadSize = 5 * 1024 * 1024 // 5 MB

type FilesRead struct {
	OS       osutil.OSExecutor
	BasePath string
}

type FilesReadParams struct {
	AccountSlug string `json:"account_slug"`
	Path        string `json:"path"`
}

type FilesReadResult struct {
	Name     string `json:"name"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"`
	Size     int64  `json:"size"`
}

func (a *FilesRead) Name() string { return "files.read" }

func (a *FilesRead) Validate(params json.RawMessage) error {
	var p FilesReadParams
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

func (a *FilesRead) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesReadParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	sizeOut, err := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/stat", "--format=%s", resolved,
	)
	if err != nil {
		return nil, fmt.Errorf("stat file: %w", err)
	}

	fileSize, err := strconv.ParseInt(strings.TrimSpace(string(sizeOut)), 10, 64)
	if err != nil {
		return nil, fmt.Errorf("parse file size: %w", err)
	}
	if fileSize > maxReadSize {
		return nil, fmt.Errorf("file too large: %d bytes (limit %d)", fileSize, maxReadSize)
	}

	data, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/cat", resolved)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}

	encoding := "utf-8"
	content := string(data)
	if isBinary(data) {
		encoding = "base64"
		content = base64.StdEncoding.EncodeToString(data)
	}

	return &FilesReadResult{
		Name:     filepath.Base(resolved),
		Content:  content,
		Encoding: encoding,
		Size:     int64(len(data)),
	}, nil
}

func isBinary(data []byte) bool {
	return bytes.ContainsRune(data, 0)
}
