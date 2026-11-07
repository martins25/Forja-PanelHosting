package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const (
	// cloudflaredImage is pinned: tunnel connectors must not change under us.
	cloudflaredImage = "docker.io/cloudflare/cloudflared:2025.11.1"

	// ForjaIngressAddr is the address Caddy listens on (besides 127.0.0.1) so
	// that rootless containers can reach it without getting access to the
	// host loopback (panel API, Caddy admin). It lives on a dummy interface
	// created by deploy/forja-ingress.netdev.
	ForjaIngressAddr = "10.255.0.1"
	cfIngressService = "http://" + ForjaIngressAddr + ":80"

	maxConnectionID = 1 << 30

	// cloudflaredEnvBase holds the tunnel-token env files. It is root-owned and
	// outside every account home: an account user can neither create entries in
	// it (so no symlink can redirect a root write) nor modify the files.
	cloudflaredEnvBase = "/srv/forja/cloudflared"
)

type CFConnectionApply struct {
	OS osutil.OSExecutor
}

type CFConnectionApplyParams struct {
	AccountSlug  string `json:"account_slug"`
	ConnectionID int    `json:"connection_id"`
	// State is "present" (create or recreate the container) or "absent" (remove it).
	State       string `json:"state"`
	TunnelID    string `json:"tunnel_id,omitempty"`
	TunnelToken string `json:"tunnel_token,omitempty"`
}

type CFConnectionApplyResult struct {
	ContainerName string `json:"container_name"`
	State         string `json:"state"`
}

func (a *CFConnectionApply) Name() string { return "cf.connection.apply" }

func cloudflaredContainerName(connectionID int) string {
	return fmt.Sprintf("cloudflared-%d", connectionID)
}

func validConnectionID(id int) error {
	if id < 1 || id > maxConnectionID {
		return fmt.Errorf("%w: invalid connection id", validate.ErrInvalid)
	}
	return nil
}

// tunnelIDFromToken extracts the tunnel id ("t") from a cloudflared token,
// which is base64(JSON{"a":account,"t":tunnel,"s":secret}).
func tunnelIDFromToken(token string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(token)
	if err != nil {
		raw, err = base64.RawStdEncoding.DecodeString(token)
		if err != nil {
			return "", fmt.Errorf("%w: invalid tunnel token", validate.ErrInvalid)
		}
	}
	var payload struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return "", fmt.Errorf("%w: invalid tunnel token", validate.ErrInvalid)
	}
	return payload.T, nil
}

func (a *CFConnectionApply) Validate(params json.RawMessage) error {
	var p CFConnectionApplyParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validConnectionID(p.ConnectionID); err != nil {
		return err
	}
	switch p.State {
	case "absent":
		return nil
	case "present":
	default:
		return fmt.Errorf("%w: invalid state %q", validate.ErrInvalid, p.State)
	}
	if err := validate.TunnelID(p.TunnelID); err != nil {
		return err
	}
	if err := validate.TunnelToken(p.TunnelToken); err != nil {
		return err
	}
	tid, err := tunnelIDFromToken(p.TunnelToken)
	if err != nil {
		return err
	}
	if tid != p.TunnelID {
		return fmt.Errorf("%w: tunnel token does not belong to tunnel_id", validate.ErrInvalid)
	}
	return nil
}

func (a *CFConnectionApply) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p CFConnectionApplyParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	envFile := filepath.Join(cloudflaredEnvBase, fmt.Sprintf("%d.env", p.ConnectionID))
	name := cloudflaredContainerName(p.ConnectionID)

	_, gid, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}

	// Stop and remove any previous container; it may not exist.
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "10", name)
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--force", name)

	if p.State == "absent" {
		// The env file is root-owned, so it is removed by the agent itself.
		if _, err := a.OS.Run(ctx, "/usr/bin/rm", "-f", "--", envFile); err != nil {
			return nil, fmt.Errorf("remove env file: %w", err)
		}
		return &CFConnectionApplyResult{ContainerName: name, State: "absent"}, nil
	}

	// The env file is readable through the account's group, so that group must
	// belong to this account alone (useradd --user-group): a shared group such as
	// "users" would expose the token to other accounts.
	groupName, err := a.OS.GroupName(gid)
	if err != nil {
		return nil, fmt.Errorf("group lookup failed: %w", err)
	}
	if groupName != linuxUser {
		return nil, fmt.Errorf("account group is shared (%s): refusing to expose the tunnel token", groupName)
	}

	// 0711: the account user can traverse to its own file but not list or create.
	// EnsureDir also repairs the mode of a pre-existing directory and refuses symlinks.
	if err := a.OS.EnsureDir(cloudflaredEnvBase, 0711, 0, 0); err != nil {
		return nil, fmt.Errorf("prepare %s: %w", cloudflaredEnvBase, err)
	}

	// The token goes through an env file, never through argv. The file is root-owned
	// and readable by the account's group only (podman reads it as the account user).
	// It is created fresh and renamed into place: a descriptor an earlier host account
	// kept open on the previous file never sees the new token.
	if err := a.OS.WriteFileAtomic(envFile, []byte("TUNNEL_TOKEN="+p.TunnelToken+"\n"), 0640, 0, gid); err != nil {
		return nil, fmt.Errorf("write env file: %w", err)
	}

	// Ingress rules come from the tunnel configuration pushed by cf.routes.sync
	// (every hostname -> cfIngressService), so cloudflared only needs the token.
	out, err := a.OS.RunAs(ctx, linuxUser,
		"/usr/bin/podman", "run",
		"--detach",
		"--name", name,
		"--network", "fj-"+p.AccountSlug,
		"--memory", "128m",
		"--cpus", "0.2",
		"--pids-limit", "64",
		"--restart", "on-failure:5",
		"--env-file", envFile,
		"--label", "forja.tunnel_id="+p.TunnelID,
		cloudflaredImage,
		"tunnel", "--no-autoupdate", "run",
	)
	if err != nil {
		return nil, fmt.Errorf("podman run failed: %w (%s)", err, truncateOutput(out))
	}

	return &CFConnectionApplyResult{ContainerName: name, State: "present"}, nil
}

func truncateOutput(b []byte) string {
	const max = 300
	if len(b) > max {
		b = b[:max]
	}
	return string(b)
}
