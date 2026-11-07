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

type LogsTail struct {
	OS osutil.OSExecutor
	// BasePath overrides the accounts base directory (tests only).
	BasePath string
}

type LogsTailParams struct {
	AccountSlug string `json:"account_slug"`
	Domain      string `json:"domain"`
	Source      string `json:"source"`
	Lines       int    `json:"lines"`
	LogPath     string `json:"log_path"`
}

type LogsTailResult struct {
	Lines  []string `json:"lines"`
	Source string   `json:"source"`
	Count  int      `json:"count"`
}

func (a *LogsTail) Name() string { return "logs.tail" }

func (a *LogsTail) Validate(params json.RawMessage) error {
	var p LogsTailParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return err
	}
	switch p.Source {
	case "app", "build", "access":
	default:
		return fmt.Errorf("%w: source must be app, build or access", validate.ErrInvalid)
	}
	if p.Lines < 1 || p.Lines > 1000 {
		return fmt.Errorf("%w: lines must be 1-1000", validate.ErrInvalid)
	}
	if p.Source == "build" && p.LogPath == "" {
		return fmt.Errorf("%w: log_path required for source=build", validate.ErrInvalid)
	}
	return nil
}

func (a *LogsTail) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p LogsTailParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	siteDir := filepath.Join(homeDir, "sites", p.Domain)
	domSafe := validate.DomainSafe(p.Domain)

	var lines []string

	switch p.Source {
	case "app":
		out, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "ps", "-q",
			"--filter", fmt.Sprintf("name=fj-%s-%s-", p.AccountSlug, domSafe),
		)
		if err != nil {
			return &LogsTailResult{Lines: []string{}, Source: p.Source, Count: 0}, nil
		}
		containerID := strings.TrimSpace(string(out))
		if containerID == "" {
			return &LogsTailResult{Lines: []string{}, Source: p.Source, Count: 0}, nil
		}
		ids := strings.Split(containerID, "\n")
		containerID = strings.TrimSpace(ids[0])

		out, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "logs",
			"--tail", strconv.Itoa(p.Lines),
			containerID,
		)
		if err != nil {
			return nil, fmt.Errorf("podman logs failed: %w", err)
		}
		lines = splitLines(string(out), p.Lines)

	case "build":
		logsDir := filepath.Join(siteDir, "logs")
		rel := filepath.Clean(p.LogPath)
		if filepath.IsAbs(rel) {
			r, err := filepath.Rel(logsDir, rel)
			if err != nil {
				return nil, fmt.Errorf("invalid log path: %w", validate.ErrInvalid)
			}
			rel = r
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("invalid log path: outside logs directory: %w", validate.ErrInvalid)
		}
		// SafePath resolves symlinks, so a link planted inside logs/ cannot
		// point the (root) agent at files outside the logs directory.
		resolved, err := validate.SafePath(logsDir, rel)
		if err != nil {
			return nil, fmt.Errorf("invalid log path: %w", err)
		}

		// Read as the account user, never as root.
		data, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/cat", resolved)
		if err != nil {
			return nil, fmt.Errorf("read build log: %w", err)
		}
		lines = splitLines(string(data), p.Lines)

	case "access":
		accessLog := filepath.Join(homeDir, "logs", "access.log")
		// logs/ belongs to the account user, so access.log may have been
		// replaced by a symlink. This read runs as root: never follow a link
		// out of the account home.
		accessLog, err := resolveWithinHome(homeDir, accessLog)
		if err != nil {
			return nil, fmt.Errorf("invalid access log path: %w", err)
		}
		data, err := a.OS.ReadFile(accessLog)
		if err != nil {
			return &LogsTailResult{Lines: []string{}, Source: p.Source, Count: 0}, nil
		}
		lines = splitLines(string(data), p.Lines)
	}

	return &LogsTailResult{
		Lines:  lines,
		Source: p.Source,
		Count:  len(lines),
	}, nil
}

// resolveWithinHome resolves symlinks of an existing path and verifies the
// result stays inside homeDir. A path that does not exist on disk has nothing
// to follow and is returned unchanged (the subsequent read simply fails).
func resolveWithinHome(homeDir, path string) (string, error) {
	base, err := filepath.EvalSymlinks(homeDir)
	if err != nil {
		return path, nil
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return path, nil
	}
	if resolved != base && !strings.HasPrefix(resolved, base+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: path escapes account home", validate.ErrInvalid)
	}
	return resolved, nil
}

func splitLines(s string, maxLines int) []string {
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return []string{}
	}
	all := strings.Split(s, "\n")
	if len(all) <= maxLines {
		return all
	}
	return all[len(all)-maxLines:]
}
