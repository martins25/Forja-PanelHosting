package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type BackupRestore struct {
	OS osutil.OSExecutor
}

type BackupRestoreParams struct {
	AccountSlug      string `json:"account_slug"`
	ResticSnapshotID string `json:"restic_snapshot_id"`
	Target           string `json:"target"`
	Confirm          bool   `json:"confirm"`
}

type BackupRestoreResult struct {
	RestoredTo string   `json:"restored_to"`
	Restarted  []string `json:"restarted"`
}

func (a *BackupRestore) Name() string { return "backup.restore" }

func (a *BackupRestore) Validate(params json.RawMessage) error {
	var p BackupRestoreParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.ResticSnapshotID(p.ResticSnapshotID); err != nil {
		return err
	}
	if err := validate.RestoreTarget(p.Target); err != nil {
		return err
	}
	if !p.Confirm {
		return fmt.Errorf("%w: confirm must be true to restore a backup", validate.ErrInvalid)
	}
	return nil
}

func (a *BackupRestore) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p BackupRestoreParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	if !p.Confirm {
		return nil, fmt.Errorf("confirm must be true to restore a backup")
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(accountsBase, p.AccountSlug)
	repoDir := filepath.Join(resticBase, p.AccountSlug)
	keyFile := repoDir + ".key"

	containers, err := a.listAccountContainers(ctx, linuxUser)
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	for _, c := range containers {
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "10", c)
	}

	restoreTarget := homeDir
	args := []string{
		"--repo", repoDir,
		"--password-file", keyFile,
		"restore", p.ResticSnapshotID,
		"--target", "/",
	}

	if strings.HasPrefix(p.Target, "site:") {
		domain := strings.TrimPrefix(p.Target, "site:")
		sitePath := filepath.Join(homeDir, "sites", domain)
		args = append(args, "--include", sitePath)
		restoreTarget = sitePath
	} else {
		args = append(args, "--include", homeDir)
	}

	if _, err := a.OS.Run(ctx, "/usr/bin/restic", args...); err != nil {
		for _, c := range containers {
			a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "start", c)
		}
		return nil, fmt.Errorf("restic restore: %w", err)
	}

	var restarted []string
	for _, c := range containers {
		if _, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "start", c); err == nil {
			restarted = append(restarted, c)
		}
	}

	return &BackupRestoreResult{
		RestoredTo: restoreTarget,
		Restarted:  restarted,
	}, nil
}

func (a *BackupRestore) listAccountContainers(ctx context.Context, linuxUser string) ([]string, error) {
	out, err := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "ps", "-a", "--format", "{{.Names}}",
	)
	if err != nil {
		return nil, err
	}

	var names []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}
