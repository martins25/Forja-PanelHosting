package actions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBSetPassword struct {
	OS osutil.OSExecutor
}

type DBSetPasswordParams struct {
	AccountSlug string `json:"account_slug"`
	Engine      string `json:"engine"`
	DBUser      string `json:"db_user"`
	NewPassword string `json:"new_password"`
}

type DBSetPasswordResult struct {
	Updated bool `json:"updated"`
}

func (a *DBSetPassword) Name() string { return "db.set_password" }

func (a *DBSetPassword) Validate(params json.RawMessage) error {
	var p DBSetPasswordParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.DBEngine(p.Engine); err != nil {
		return err
	}
	if err := validate.DBUser(p.DBUser); err != nil {
		return err
	}
	if err := validate.DBPassword(p.NewPassword); err != nil {
		return err
	}
	return nil
}

func (a *DBSetPassword) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBSetPasswordParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	containerName := dbContainerName(p.AccountSlug, p.Engine)

	switch p.Engine {
	case "mariadb", "mysql":
		sql := fmt.Sprintf("ALTER USER '%s'@'%%' IDENTIFIED BY '%s'; FLUSH PRIVILEGES;", p.DBUser, p.NewPassword)
		_, err := mysqlRootExec(ctx, a.OS, p.AccountSlug, p.Engine, containerName, "",
			"mysql", "-u", "root", "-e", sql,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to set password for engine %s", p.Engine)
		}
	case "postgres":
		sql := fmt.Sprintf(`ALTER ROLE "%s" WITH PASSWORD '%s'`, p.DBUser, p.NewPassword)
		_, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec", "--", containerName,
			"psql", "-U", "postgres", "-c", sql,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to set postgres password")
		}
	}

	return &DBSetPasswordResult{Updated: true}, nil
}
