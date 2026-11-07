package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"time"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBDump struct {
	OS       osutil.OSExecutor
	BasePath string // override accountsBase in tests
}

type DBDumpParams struct {
	AccountSlug string `json:"account_slug"`
	Engine      string `json:"engine"`
	DBName      string `json:"db_name"`
	DBUser      string `json:"db_user"`
	DBPassword  string `json:"db_password"`
}

type DBDumpResult struct {
	Path string `json:"path"`
}

func (a *DBDump) Name() string { return "db.dump" }

func (a *DBDump) Validate(params json.RawMessage) error {
	var p DBDumpParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.DBEngine(p.Engine); err != nil {
		return err
	}
	if err := validate.DBName(p.DBName); err != nil {
		return err
	}
	if err := validate.DBUser(p.DBUser); err != nil {
		return err
	}
	if err := validate.DBPassword(p.DBPassword); err != nil {
		return err
	}
	return nil
}

func (a *DBDump) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBDumpParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(filesBase(a.BasePath), p.AccountSlug)
	containerName := dbContainerName(p.AccountSlug, p.Engine)

	uid, _, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}

	backupsDir := filepath.Join(homeDir, "backups")
	if err := requireRealDirInHome(homeDir, backupsDir); err != nil {
		return nil, fmt.Errorf("backups dir: %w", err)
	}
	if err := a.OS.EnsureDir(backupsDir, 0750, uid, 0); err != nil {
		return nil, fmt.Errorf("create backups dir: %w", err)
	}

	ts := time.Now().UTC().Format("20060102-150405")
	dumpFile := fmt.Sprintf("db-%s-%s.sql", p.DBName, ts)
	dumpPath := filepath.Join(backupsDir, dumpFile)

	var dumpOut []byte

	switch p.Engine {
	case "mariadb", "mysql":
		dumpOut, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec",
			"--env", "MYSQL_PWD="+p.DBPassword,
			"--", containerName,
			"mysqldump", "-u", p.DBUser, "--", p.DBName,
		)
	case "postgres":
		dumpOut, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec",
			"--env", "PGPASSWORD="+p.DBPassword,
			"--", containerName,
			"pg_dump", "-U", p.DBUser, "--", p.DBName,
		)
	}

	if err != nil {
		return nil, fmt.Errorf("dump %s: %w", p.Engine, err)
	}

	// The account owns backups/ and may have planted a symlink at dumpPath
	// (the name is predictable): write atomically, never through it.
	if err := writeFileInHome(ctx, a.OS, homeDir, dumpPath, dumpOut, 0640, uid, 0); err != nil {
		return nil, fmt.Errorf("write dump file: %w", err)
	}

	return &DBDumpResult{Path: dumpPath}, nil
}
