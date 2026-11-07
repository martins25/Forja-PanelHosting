package actions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBDrop struct {
	OS osutil.OSExecutor
}

type DBDropParams struct {
	AccountSlug  string `json:"account_slug"`
	Engine       string `json:"engine"`
	DBName       string `json:"db_name"`
	DBUser       string `json:"db_user"`
	RemainingDBs int    `json:"remaining_dbs"`
}

type DBDropResult struct {
	Dropped bool `json:"dropped"`
}

func (a *DBDrop) Name() string { return "db.drop" }

func (a *DBDrop) Validate(params json.RawMessage) error {
	var p DBDropParams
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
	if p.RemainingDBs < 0 {
		return fmt.Errorf("%w: remaining_dbs cannot be negative", validate.ErrInvalid)
	}
	return nil
}

func (a *DBDrop) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBDropParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	containerName := dbContainerName(p.AccountSlug, p.Engine)

	switch p.Engine {
	case "mariadb", "mysql":
		dropSQL := fmt.Sprintf(
			"DROP DATABASE IF EXISTS `%s`; DROP USER IF EXISTS '%s'@'%%'; FLUSH PRIVILEGES;",
			p.DBName, p.DBUser,
		)
		_, err := mysqlRootExec(ctx, a.OS, p.AccountSlug, p.Engine, containerName, "",
			"mysql", "-u", "root", "-e", dropSQL,
		)
		if err != nil {
			return nil, fmt.Errorf("drop database/user (%s): %w", p.Engine, err)
		}
	case "postgres":
		dropDB := fmt.Sprintf(`DROP DATABASE IF EXISTS "%s"`, p.DBName)
		_, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec", "--", containerName,
			"psql", "-U", "postgres", "-c", dropDB,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to drop postgres database")
		}
		dropUser := fmt.Sprintf(`DROP USER IF EXISTS "%s"`, p.DBUser)
		_, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec", "--", containerName,
			"psql", "-U", "postgres", "-c", dropUser,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to drop postgres user")
		}
	}

	if p.RemainingDBs == 0 {
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "10", "--", containerName)
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", containerName)
	}

	return &DBDropResult{Dropped: true}, nil
}
