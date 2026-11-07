package actions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBCreate struct {
	OS osutil.OSExecutor
}

type DBCreateParams struct {
	AccountSlug string `json:"account_slug"`
	Engine      string `json:"engine"`
	DBName      string `json:"db_name"`
	DBUser      string `json:"db_user"`
	DBPassword  string `json:"db_password"`
}

type DBCreateResult struct {
	Engine        string `json:"engine"`
	DBName        string `json:"db_name"`
	ContainerName string `json:"container_name"`
	// RootPassword is set only when this call created the engine container.
	// The caller must store it encrypted; it is never logged by the agent.
	RootPassword string `json:"root_password,omitempty"`
}

func (a *DBCreate) Name() string { return "db.create" }

func (a *DBCreate) Validate(params json.RawMessage) error {
	var p DBCreateParams
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

func dbContainerName(slug, engine string) string {
	return fmt.Sprintf("fj-%s-%s", slug, engine)
}

func dbImage(engine string) string {
	switch engine {
	case "mariadb":
		return "docker.io/library/mariadb:11"
	case "mysql":
		return "docker.io/library/mysql:8"
	case "postgres":
		return "docker.io/library/postgres:16"
	default:
		return ""
	}
}

func dbDataMount(engine string) string {
	switch engine {
	case "mariadb", "mysql":
		return "/var/lib/mysql"
	case "postgres":
		return "/var/lib/postgresql/data"
	default:
		return ""
	}
}

func (a *DBCreate) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(accountsBase, p.AccountSlug)
	containerName := dbContainerName(p.AccountSlug, p.Engine)

	uid, _, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}

	dataDir := filepath.Join(homeDir, "databases", p.Engine, "data")
	if err := a.OS.EnsureDir(dataDir, 0750, uid, 0); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	var rootPassword string
	_, inspectErr := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "inspect", "--type", "container", "--", containerName,
	)
	if inspectErr != nil {
		var err error
		rootPassword, err = newRootPassword()
		if err != nil {
			return nil, err
		}
		envFile := filepath.Join(filepath.Dir(dataDir), "root.env")
		if err := a.startEngine(ctx, linuxUser, uid, containerName, p.Engine, dataDir, envFile, rootPassword); err != nil {
			return nil, err
		}
		if err := a.waitForEngine(ctx, linuxUser, containerName, p.Engine); err != nil {
			return nil, err
		}
	}

	if err := a.createDBAndUser(ctx, linuxUser, containerName, p.Engine, p.DBName, p.DBUser, p.DBPassword, rootPassword); err != nil {
		return nil, err
	}

	return &DBCreateResult{
		Engine:        p.Engine,
		DBName:        p.DBName,
		ContainerName: containerName,
		RootPassword:  rootPassword,
	}, nil
}

// newRootPassword returns 32 random bytes, hex encoded.
func newRootPassword() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate root password: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// engineEnv returns the variable each official image uses to set the
// superuser password at first start. (Postgres keeps trusting the in-container
// unix socket, so `podman exec ... psql` still works, but every TCP
// connection, e.g. from another container, now needs this password.)
func engineEnv(engine, rootPassword string) []string {
	switch engine {
	case "mariadb", "mysql":
		return []string{mysqlRootEnvVar(engine) + "=" + rootPassword}
	case "postgres":
		return []string{"POSTGRES_PASSWORD=" + rootPassword}
	}
	return nil
}

func (a *DBCreate) startEngine(ctx context.Context, linuxUser string, uid int, containerName, engine, dataDir, envFile, rootPassword string) error {
	image := dbImage(engine)
	mount := dataDir + ":" + dbDataMount(engine) + ":Z"

	args := []string{
		"run", "--detach",
		"--name", containerName,
		"--network", "fj-" + strings.TrimPrefix(linuxUser, linuxUserPfx),
		"--memory", "512m",
		"--cpus", "1.0",
		"--pids-limit", "128",
		"--restart", "on-failure:3",
		"--volume", mount,
	}

	// The secret goes through a 0400 env-file owned by the account user (not
	// through argv, which any local user can read with ps) and is removed as
	// soon as the container has been created.
	content := strings.Join(engineEnv(engine, rootPassword), "\n") + "\n"
	if err := a.OS.WriteFileAtomic(envFile, []byte(content), 0400, uid, 0); err != nil {
		return fmt.Errorf("write engine env file: %w", err)
	}
	defer func() {
		_, _ = a.OS.RunAs(ctx, linuxUser, "/usr/bin/rm", "-f", "--", envFile)
	}()
	args = append(args, "--env-file", envFile, image)

	_, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", args...)
	if err != nil {
		return fmt.Errorf("start %s container: %w", engine, err)
	}
	return nil
}

func (a *DBCreate) waitForEngine(ctx context.Context, linuxUser, containerName, engine string) error {
	var checkCmd []string
	switch engine {
	case "mariadb", "mysql":
		checkCmd = []string{
			"/usr/bin/podman", "exec", "--", containerName,
			"mysqladmin", "ping", "--silent",
		}
	case "postgres":
		checkCmd = []string{
			"/usr/bin/podman", "exec", "--", containerName,
			"pg_isready",
		}
	}

	for i := 0; i < 30; i++ {
		_, err := a.OS.RunAs(ctx, linuxUser, checkCmd[0], checkCmd[1:]...)
		if err == nil {
			return nil
		}
		time.Sleep(time.Second)
	}
	return fmt.Errorf("engine %s did not become ready in time", engine)
}

func (a *DBCreate) createDBAndUser(ctx context.Context, linuxUser, containerName, engine, dbName, dbUser, dbPassword, rootPassword string) error {
	switch engine {
	case "mariadb", "mysql":
		sql := fmt.Sprintf(
			"CREATE DATABASE IF NOT EXISTS `%s`; "+
				"CREATE USER IF NOT EXISTS '%s'@'%%' IDENTIFIED BY '%s'; "+
				"GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'%%'; "+
				"FLUSH PRIVILEGES;",
			dbName, dbUser, dbPassword, dbName, dbUser,
		)
		_, err := mysqlRootExec(ctx, a.OS, strings.TrimPrefix(linuxUser, linuxUserPfx), engine, containerName, rootPassword,
			"mysql", "-u", "root", "-e", sql,
		)
		if err != nil {
			return fmt.Errorf("failed to create database and user for engine %s", engine)
		}
	case "postgres":
		createUser := fmt.Sprintf(`CREATE USER "%s" WITH PASSWORD '%s'`, dbUser, dbPassword)
		_, err := a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec", "--", containerName,
			"psql", "-U", "postgres", "-c", createUser,
		)
		if err != nil {
			return fmt.Errorf("failed to create postgres user")
		}
		createDB := fmt.Sprintf(`CREATE DATABASE "%s" OWNER "%s"`, dbName, dbUser)
		_, err = a.OS.RunAs(ctx, linuxUser,
			"/usr/bin/podman", "exec", "--", containerName,
			"psql", "-U", "postgres", "-c", createDB,
		)
		if err != nil {
			return fmt.Errorf("failed to create postgres database")
		}
	}
	return nil
}
