package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type FilesList struct {
	OS       osutil.OSExecutor
	BasePath string // override accountsBase in tests
}

type FilesListParams struct {
	AccountSlug string `json:"account_slug"`
	Path        string `json:"path"`
}

type FileEntry struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Size        int64  `json:"size"`
	ModTime     int64  `json:"mod_time"`
	Permissions string `json:"permissions"`
}

type FilesListResult struct {
	Entries []FileEntry `json:"entries"`
	Path    string      `json:"path"`
}

func (a *FilesList) Name() string { return "files.list" }

func (a *FilesList) Validate(params json.RawMessage) error {
	var p FilesListParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if p.Path == "" {
		p.Path = "."
	}
	return nil
}

func (a *FilesList) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p FilesListParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	if p.Path == "" {
		p.Path = "."
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)

	resolved, err := validate.SafePath(homeDir, p.Path)
	if err != nil {
		return nil, fmt.Errorf("invalid path: %w", err)
	}

	out, err := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/find", resolved,
		"-maxdepth", "1", "-mindepth", "1",
		"-printf", `%f\t%y\t%s\t%T@\t%#m\n`,
	)
	if err != nil {
		return nil, fmt.Errorf("list directory: %w", err)
	}

	entries := parseFileEntries(string(out))

	return &FilesListResult{
		Entries: entries,
		Path:    p.Path,
	}, nil
}

func filesBase(override string) string {
	if override != "" {
		return override
	}
	return accountsBase
}

func parseFileEntries(output string) []FileEntry {
	if strings.TrimSpace(output) == "" {
		return []FileEntry{}
	}

	lines := strings.Split(strings.TrimRight(output, "\n"), "\n")
	entries := make([]FileEntry, 0, len(lines))

	for _, line := range lines {
		parts := strings.SplitN(line, "\t", 5)
		if len(parts) != 5 {
			continue
		}

		size, _ := strconv.ParseInt(parts[2], 10, 64)

		modFloat, _ := strconv.ParseFloat(parts[3], 64)
		modTime := int64(modFloat)

		fileType := "file"
		switch parts[1] {
		case "d":
			fileType = "dir"
		case "l":
			fileType = "symlink"
		}

		entries = append(entries, FileEntry{
			Name:        parts[0],
			Type:        fileType,
			Size:        size,
			ModTime:     modTime,
			Permissions: parts[4],
		})
	}

	return entries
}
