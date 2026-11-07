package actions

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

// mysqlRootEnvVar is the variable that carries the root password in the
// container configuration of each MySQL-family image.
func mysqlRootEnvVar(engine string) string {
	if engine == "mysql" {
		return "MYSQL_ROOT_PASSWORD"
	}
	return "MARIADB_ROOT_PASSWORD"
}

// containerRootPassword reads the root password from the container's own
// configuration. It returns "" for containers created before root passwords
// were introduced (or when it cannot be read), which keeps them working.
func containerRootPassword(ctx context.Context, osx osutil.OSExecutor, linuxUser, containerName, engine string) string {
	out, err := osx.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "inspect", "--type", "container",
		"--format", "{{range .Config.Env}}{{println .}}{{end}}",
		"--", containerName,
	)
	if err != nil {
		return ""
	}
	prefix := mysqlRootEnvVar(engine) + "="
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	return ""
}

// mysqlRootExec runs a MySQL/MariaDB client command inside the engine
// container as root. The root password (knownPassword, or the one stored in
// the container configuration) is handed over as MYSQL_PWD through a 0400
// env-file owned by the account user, never through argv, and the file is
// removed afterwards.
func mysqlRootExec(ctx context.Context, osx osutil.OSExecutor, slug, engine, containerName, knownPassword string, clientArgs ...string) ([]byte, error) {
	linuxUser := linuxUserPfx + slug
	password := knownPassword
	if password == "" {
		password = containerRootPassword(ctx, osx, linuxUser, containerName, engine)
	}

	args := []string{"exec"}
	if password != "" {
		uid, _, err := osx.LookupUser(linuxUser)
		if err != nil {
			return nil, fmt.Errorf("account user not found: %w", err)
		}
		envFile := filepath.Join(accountsBase, slug, "databases", engine, "exec-auth.env")
		if err := osx.WriteFileAtomic(envFile, []byte("MYSQL_PWD="+password+"\n"), 0400, uid, 0); err != nil {
			return nil, fmt.Errorf("write auth env file: %w", err)
		}
		defer func() {
			_, _ = osx.RunAs(ctx, linuxUser, "/usr/bin/rm", "-f", "--", envFile)
		}()
		args = append(args, "--env-file", envFile)
	}
	args = append(args, "--", containerName)
	args = append(args, clientArgs...)
	return osx.RunAs(ctx, linuxUser, "/usr/bin/podman", args...)
}
