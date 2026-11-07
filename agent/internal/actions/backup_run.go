package actions

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const (
	resticBase = "/var/lib/forja/restic"
)

type BackupRun struct {
	OS       osutil.OSExecutor
	BasePath string // override accountsBase in tests
}

type BackupRunParams struct {
	AccountSlug string   `json:"account_slug"`
	Scope       string   `json:"scope"`
	Databases   []DBInfo `json:"databases"`
}

type DBInfo struct {
	Engine     string `json:"engine"`
	DBName     string `json:"db_name"`
	DBUser     string `json:"db_user"`
	DBPassword string `json:"db_password"`
}

type BackupRunResult struct {
	ResticSnapshotID string `json:"restic_snapshot_id"`
	SizeBytes        int64  `json:"size_bytes"`
}

func (a *BackupRun) Name() string { return "backup.run" }

func (a *BackupRun) Validate(params json.RawMessage) error {
	var p BackupRunParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.BackupScope(p.Scope); err != nil {
		return err
	}
	for _, db := range p.Databases {
		if err := validate.DBEngine(db.Engine); err != nil {
			return err
		}
		if err := validate.DBName(db.DBName); err != nil {
			return err
		}
		if err := validate.DBUser(db.DBUser); err != nil {
			return err
		}
		if err := validate.DBPassword(db.DBPassword); err != nil {
			return err
		}
	}
	return nil
}


func (a *BackupRun) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p BackupRunParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	repoDir := filepath.Join(resticBase, p.AccountSlug)
	keyFile := repoDir + ".key"

	if err := a.ensureResticRepo(ctx, repoDir, keyFile); err != nil {
		return nil, fmt.Errorf("init restic repo: %w", err)
	}

	if p.Scope != "sites" {
		dumper := &DBDump{OS: a.OS, BasePath: a.BasePath}
		for _, db := range p.Databases {
			dumpParams, _ := json.Marshal(DBDumpParams{
				AccountSlug: p.AccountSlug,
				Engine:      db.Engine,
				DBName:      db.DBName,
				DBUser:      db.DBUser,
				DBPassword:  db.DBPassword,
			})
			if _, err := dumper.Execute(ctx, dumpParams); err != nil {
				return nil, fmt.Errorf("dump db %s: %w", db.DBName, err)
			}
		}
	}

	excludes := []string{
		"--exclude", "node_modules",
		"--exclude", "__pycache__",
		"--exclude", ".cache",
		"--exclude", "vendor",
	}

	args := []string{
		"--repo", repoDir,
		"--password-file", keyFile,
		"--json",
		"backup",
	}
	args = append(args, excludes...)

	switch p.Scope {
	case "databases":
		args = append(args, filepath.Join(homeDir, "backups"))
	default:
		args = append(args, homeDir)
	}

	out, err := a.OS.Run(ctx, "/usr/bin/restic", args...)
	if err != nil {
		return nil, fmt.Errorf("restic backup: %w", err)
	}

	snapshotID, sizeBytes := parseResticOutput(string(out))
	if snapshotID == "" {
		return nil, fmt.Errorf("could not parse restic snapshot id from output")
	}

	return &BackupRunResult{
		ResticSnapshotID: snapshotID,
		SizeBytes:        sizeBytes,
	}, nil
}

func (a *BackupRun) ensureResticRepo(ctx context.Context, repoDir, keyFile string) error {
	if err := a.OS.MkdirAll(repoDir, 0700); err != nil {
		return err
	}

	if _, err := a.OS.ReadFile(keyFile); errors.Is(err, os.ErrNotExist) {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return fmt.Errorf("generate restic key: %w", err)
		}
		hexKey := fmt.Sprintf("%x", key)
		if err := a.OS.WriteFile(keyFile, []byte(hexKey), 0600); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}

	configPath := filepath.Join(repoDir, "config")
	if _, err := a.OS.ReadFile(configPath); errors.Is(err, os.ErrNotExist) {
		if _, err := a.OS.Run(ctx,
			"/usr/bin/restic", "--repo", repoDir, "--password-file", keyFile, "init",
		); err != nil {
			return fmt.Errorf("restic init: %w", err)
		}
	} else if err != nil {
		return err
	}

	return nil
}

func parseResticOutput(out string) (string, int64) {
	snapshotID := parseJSONSnapshotID(out)
	sizeBytes := parseJSONSize(out)
	return snapshotID, sizeBytes
}

func parseJSONSnapshotID(out string) string {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, `"snapshot_id"`) {
			var msg struct {
				SnapshotID string `json:"snapshot_id"`
			}
			if json.Unmarshal([]byte(line), &msg) == nil && msg.SnapshotID != "" {
				return msg.SnapshotID
			}
		}
	}
	return ""
}

func parseJSONSize(out string) int64 {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, `"total_bytes_processed"`) {
			var msg struct {
				TotalBytesProcessed int64 `json:"total_bytes_processed"`
			}
			if json.Unmarshal([]byte(line), &msg) == nil {
				return msg.TotalBytesProcessed
			}
		}
		if strings.Contains(line, `"data_added"`) {
			var msg struct {
				DataAdded int64 `json:"data_added"`
			}
			if json.Unmarshal([]byte(line), &msg) == nil && msg.DataAdded > 0 {
				return msg.DataAdded
			}
		}
	}

	return 0
}
