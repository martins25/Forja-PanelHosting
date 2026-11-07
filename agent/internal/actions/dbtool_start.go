package actions

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBToolStart struct {
	OS osutil.OSExecutor
}

type DBToolStartParams struct {
	AccountSlug string `json:"account_slug"`
	Tool        string `json:"tool"`
	Engine      string `json:"engine"`
	DBHost      string `json:"db_host"`
}

type DBToolStartResult struct {
	Port          int    `json:"port"`
	ContainerName string `json:"container_name"`
	// AdminPassword is only set for pgadmin (random per start).
	AdminPassword string `json:"admin_password,omitempty"`
}

// maxToolStartAttempts bounds the retries when the chosen host port is taken
// between findFreePort and podman binding it.
const maxToolStartAttempts = 3

func (a *DBToolStart) Name() string { return "dbtool.start" }

func (a *DBToolStart) Validate(params json.RawMessage) error {
	var p DBToolStartParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.WebTool(p.Tool); err != nil {
		return err
	}
	if err := validate.DBEngine(p.Engine); err != nil {
		return err
	}
	if p.DBHost == "" {
		return fmt.Errorf("%w: db_host is required", validate.ErrInvalid)
	}
	if err := validate.ContainerName(p.DBHost); err != nil {
		return err
	}
	return nil
}

func toolImage(tool string) string {
	switch tool {
	case "phpmyadmin":
		return "docker.io/library/phpmyadmin:5"
	case "adminer":
		return "docker.io/library/adminer:4"
	case "pgadmin":
		return "docker.io/dpage/pgadmin4:8"
	default:
		return ""
	}
}

func toolContainerName(slug, tool string) string {
	return fmt.Sprintf("fj-%s-%s", slug, tool)
}

func findFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("find free port: %w", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port, nil
}

func (a *DBToolStart) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBToolStartParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	containerName := toolContainerName(p.AccountSlug, p.Tool)
	network := "fj-" + p.AccountSlug

	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "5", "--", containerName)
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", containerName)

	image := toolImage(p.Tool)
	containerPort := 80
	envVars := toolEnvVars(p.Tool, p.Engine, p.DBHost)

	result := &DBToolStartResult{ContainerName: containerName}

	// pgAdmin gets a random admin password. It goes through a 0400 env-file
	// owned by the account user (never through argv) removed after the run.
	var envFile string
	if p.Tool == "pgadmin" {
		password, err := randomHex(32)
		if err != nil {
			return nil, err
		}
		uid, _, err := a.OS.LookupUser(linuxUser)
		if err != nil {
			return nil, fmt.Errorf("lookup user: %w", err)
		}
		envFile = filepath.Join(accountsBase, p.AccountSlug, ".pgadmin.env")
		content := "PGADMIN_DEFAULT_PASSWORD=" + password + "\n"
		if err := a.OS.WriteFileAtomic(envFile, []byte(content), 0400, uid, 0); err != nil {
			return nil, fmt.Errorf("write pgadmin env file: %w", err)
		}
		defer func() {
			_, _ = a.OS.RunAs(ctx, linuxUser, "/usr/bin/rm", "-f", "--", envFile)
		}()
		result.AdminPassword = password
	}

	var lastErr error
	for attempt := 0; attempt < maxToolStartAttempts; attempt++ {
		port, err := findFreePort()
		if err != nil {
			return nil, err
		}

		args := []string{
			"run", "--detach",
			"--name", containerName,
			"--network", network,
			"--publish", fmt.Sprintf("127.0.0.1:%d:%d", port, containerPort),
			"--pids-limit", "64",
			"--restart", "no",
		}
		for _, env := range envVars {
			args = append(args, "--env", env)
		}
		if envFile != "" {
			args = append(args, "--env-file", envFile)
		}
		args = append(args, image)

		out, err := a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", args...)
		if err == nil {
			result.Port = port
			return result, nil
		}
		lastErr = err
		if !isPortInUse(string(out), err) {
			break
		}
		// The failed run may have left a created container behind.
		a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "-f", "--", containerName)
	}

	return nil, fmt.Errorf("start %s: %w", p.Tool, lastErr)
}

// isPortInUse reports whether a podman failure was caused by the host port
// already being bound.
func isPortInUse(output string, err error) bool {
	msg := strings.ToLower(output + " " + err.Error())
	return strings.Contains(msg, "address already in use") ||
		strings.Contains(msg, "port is already allocated") ||
		strings.Contains(msg, "bind: address in use")
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate random: %w", err)
	}
	return hex.EncodeToString(b), nil
}

func toolEnvVars(tool, engine, dbHost string) []string {
	switch tool {
	case "phpmyadmin":
		return []string{
			"PMA_HOST=" + dbHost,
			"PMA_ABSOLUTE_URI=/",
		}
	case "adminer":
		server := dbHost
		driver := "mysql"
		if strings.Contains(engine, "postgres") {
			driver = "pgsql"
		}
		return []string{
			"ADMINER_DEFAULT_SERVER=" + server,
			"ADMINER_DEFAULT_DRIVER=" + driver,
		}
	case "pgadmin":
		return []string{
			"PGADMIN_DEFAULT_EMAIL=admin@forja.local",
			"PGADMIN_CONFIG_SERVER_MODE=False",
		}
	default:
		return nil
	}
}
