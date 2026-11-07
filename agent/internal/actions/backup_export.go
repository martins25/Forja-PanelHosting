package actions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const (
	exportsBase = "/var/lib/forja/exports"
)

type BackupExport struct {
	OS       osutil.OSExecutor
	HomeBase string // override accountsBase in tests
}

type BackupExportParams struct {
	AccountSlug string   `json:"account_slug"`
	SiteDomain  string   `json:"site_domain"`
	Databases   []DBInfo `json:"databases"`
}

type BackupExportResult struct {
	Path      string `json:"path"`
	Token     string `json:"token"`
	SizeBytes int64  `json:"size_bytes"`
}

func (a *BackupExport) Name() string { return "backup.export" }

func (a *BackupExport) Validate(params json.RawMessage) error {
	var p BackupExportParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if p.SiteDomain != "" {
		if err := validate.Hostname(p.SiteDomain); err != nil {
			return err
		}
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

func (a *BackupExport) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p BackupExportParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	base := accountsBase
	if a.HomeBase != "" {
		base = a.HomeBase
	}
	homeDir := filepath.Join(base, p.AccountSlug)

	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("generate export token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes)

	if err := a.OS.MkdirAll(exportsBase, 0700); err != nil {
		return nil, fmt.Errorf("create exports dir: %w", err)
	}

	if len(p.Databases) > 0 {
		dumper := &DBDump{OS: a.OS, BasePath: a.HomeBase}
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

	var sourceDir string
	if p.SiteDomain != "" {
		sourceDir = filepath.Join(homeDir, "sites", p.SiteDomain)
	} else {
		sourceDir = homeDir
	}

	resolvedSource, err := filepath.EvalSymlinks(sourceDir)
	if err != nil {
		return nil, fmt.Errorf("resolve source dir: %w", err)
	}
	resolvedHome, err := filepath.EvalSymlinks(homeDir)
	if err != nil {
		return nil, fmt.Errorf("resolve home dir: %w", err)
	}
	if !strings.HasPrefix(resolvedSource, resolvedHome+"/") && resolvedSource != resolvedHome {
		return nil, fmt.Errorf("source dir escapes account home")
	}
	sourceDir = resolvedSource

	tarPath := filepath.Join(exportsBase, token+".tar.gz")

	_, err = a.OS.Run(ctx,
		"/usr/bin/tar", "-czf", tarPath,
		"-C", sourceDir,
		"--exclude=node_modules",
		"--exclude=__pycache__",
		"--exclude=.cache",
		"--exclude=vendor",
		".",
	)
	if err != nil {
		return nil, fmt.Errorf("create archive: %w", err)
	}

	// Make readable by the panel process (user forja) — the random
	// 64-char hex token in the filename provides the access control.
	_, err = a.OS.Run(ctx, "/usr/bin/chmod", "0644", tarPath)
	if err != nil {
		return nil, fmt.Errorf("chmod archive: %w", err)
	}

	sizeOut, err := a.OS.Run(ctx, "/usr/bin/stat", "--printf=%s", tarPath)
	if err != nil {
		return nil, fmt.Errorf("stat archive: %w", err)
	}
	sizeBytes, _ := strconv.ParseInt(strings.TrimSpace(string(sizeOut)), 10, 64)

	return &BackupExportResult{
		Path:      tarPath,
		Token:     token,
		SizeBytes: sizeBytes,
	}, nil
}
