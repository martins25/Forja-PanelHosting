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

const (
	accountsBase   = "/srv/forja/accounts"
	linuxUserPfx   = "fj-"
	subIDBlockSize = 65536
	subIDStart     = 100000
)

type AccountCreate struct {
	OS osutil.OSExecutor
}

type AccountCreateParams struct {
	Slug      string `json:"slug"`
	CPUMillis int    `json:"cpu_millis"`
	MemoryMB  int    `json:"memory_mb"`
	DiskMB    int    `json:"disk_mb"`
}

type AccountCreateResult struct {
	LinuxUser string `json:"linux_user"`
	UID       int    `json:"uid"`
	HomeDir   string `json:"home_dir"`
}

func (a *AccountCreate) Name() string { return "account.create" }

func (a *AccountCreate) Validate(params json.RawMessage) error {
	var p AccountCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.Slug); err != nil {
		return err
	}
	if p.CPUMillis < 100 || p.CPUMillis > 16000 {
		return fmt.Errorf("%w: cpu_millis must be 100-16000", validate.ErrInvalid)
	}
	if p.MemoryMB < 64 || p.MemoryMB > 65536 {
		return fmt.Errorf("%w: memory_mb must be 64-65536", validate.ErrInvalid)
	}
	if p.DiskMB < 100 || p.DiskMB > 1048576 {
		return fmt.Errorf("%w: disk_mb must be 100-1048576", validate.ErrInvalid)
	}
	return nil
}

func (a *AccountCreate) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p AccountCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.Slug
	homeDir := filepath.Join(accountsBase, p.Slug)

	// 1. Create Linux user
	_, err := a.OS.Run(ctx, "/usr/sbin/useradd",
		"--system",
		// Private group named after the user: later features share files with the
		// account through its group, which must never be shared between accounts.
		"--user-group",
		"--shell", "/usr/sbin/nologin",
		"--home-dir", homeDir,
		"--create-home",
		linuxUser,
	)
	if err != nil {
		return nil, fmt.Errorf("useradd failed: %w", err)
	}

	// 2. Set home directory permissions
	if err := a.OS.Chown(homeDir, 0, 0); err != nil {
		return nil, fmt.Errorf("chown home failed: %w", err)
	}

	// 3. Look up UID/GID of the new user
	uid, gid, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("lookup user failed: %w", err)
	}

	// 4. Assign subuids/subgids
	if err := a.appendSubIDs(ctx, "/etc/subuid", linuxUser); err != nil {
		return nil, fmt.Errorf("subuid failed: %w", err)
	}
	if err := a.appendSubIDs(ctx, "/etc/subgid", linuxUser); err != nil {
		return nil, fmt.Errorf("subgid failed: %w", err)
	}

	// 5. Create internal directories owned by the account user
	subdirs := []string{"sites", "logs", "tmp", "backups"}
	for _, sub := range subdirs {
		dir := filepath.Join(homeDir, sub)
		if err := a.OS.MkdirAll(dir, 0750); err != nil {
			return nil, fmt.Errorf("mkdir %s failed: %w", sub, err)
		}
		if err := a.OS.Chown(dir, uid, gid); err != nil {
			return nil, fmt.Errorf("chown %s failed: %w", sub, err)
		}
	}

	// 6. Create Podman network (as the account user)
	netName := "fj-" + p.Slug
	_, err = a.OS.RunAs(ctx, linuxUser, "podman", "network", "create", netName)
	if err != nil {
		return nil, fmt.Errorf("podman network create failed: %w", err)
	}

	return &AccountCreateResult{
		LinuxUser: linuxUser,
		UID:       uid,
		HomeDir:   homeDir,
	}, nil
}

func (a *AccountCreate) appendSubIDs(_ context.Context, filePath, username string) error {
	existing, err := a.OS.ReadFile(filePath)
	if err != nil {
		existing = []byte{}
	}

	// Calculate next available offset
	offset := subIDStart
	for _, line := range strings.Split(string(existing), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) == 3 {
			var start, count int
			fmt.Sscanf(parts[1], "%d", &start)
			fmt.Sscanf(parts[2], "%d", &count)
			end := start + count
			if end > offset {
				offset = end
			}
		}
	}

	entry := fmt.Sprintf("%s:%d:%d\n", username, offset, subIDBlockSize)
	newContent := string(existing)
	if len(newContent) > 0 && !strings.HasSuffix(newContent, "\n") {
		newContent += "\n"
	}
	newContent += entry

	return a.OS.WriteFile(filePath, []byte(newContent), 0644)
}
