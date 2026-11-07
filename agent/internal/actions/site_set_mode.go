package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type SiteSetMode struct {
	OS osutil.OSExecutor
}

type SiteSetModeParams struct {
	AccountSlug string `json:"account_slug"`
	Domain      string `json:"domain"`
	Mode        string `json:"mode"`
}

type SiteSetModeResult struct {
	ContainersStopped int `json:"containers_stopped"`
	ContainersStarted int `json:"containers_started"`
}

func (a *SiteSetMode) Name() string { return "site.set_mode" }

func (a *SiteSetMode) Validate(params json.RawMessage) error {
	var p SiteSetModeParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return err
	}
	switch p.Mode {
	case "online", "maintenance", "disabled":
	default:
		return fmt.Errorf("%w: invalid mode %q", validate.ErrInvalid, p.Mode)
	}
	return nil
}

func (a *SiteSetMode) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p SiteSetModeParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	user := "fj-" + p.AccountSlug
	domSafe := validate.DomainSafe(p.Domain)
	filter := fmt.Sprintf("name=fj-%s-%s-", p.AccountSlug, domSafe)

	result := &SiteSetModeResult{}

	switch p.Mode {
	case "disabled":
		out, err := a.OS.RunAs(ctx, user, "/usr/bin/podman", "ps", "-q", "--filter", filter)
		if err != nil {
			return nil, fmt.Errorf("list containers: %w", err)
		}
		ids := parseContainerIDs(string(out))
		if len(ids) == 0 {
			return result, nil
		}
		args := append([]string{"stop", "--time", "30"}, ids...)
		if _, err := a.OS.RunAs(ctx, user, "/usr/bin/podman", args...); err != nil {
			return nil, fmt.Errorf("stop containers: %w", err)
		}
		result.ContainersStopped = len(ids)

	case "online":
		out, err := a.OS.RunAs(ctx, user, "/usr/bin/podman", "ps", "-a", "-q", "--filter", filter, "--filter", "status=exited")
		if err != nil {
			return nil, fmt.Errorf("list stopped containers: %w", err)
		}
		ids := parseContainerIDs(string(out))
		if len(ids) == 0 {
			return result, nil
		}
		args := append([]string{"start"}, ids...)
		if _, err := a.OS.RunAs(ctx, user, "/usr/bin/podman", args...); err != nil {
			return nil, fmt.Errorf("start containers: %w", err)
		}
		result.ContainersStarted = len(ids)

	case "maintenance":
		// no-op: container keeps running
	}

	return result, nil
}

func parseContainerIDs(output string) []string {
	var ids []string
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			ids = append(ids, line)
		}
	}
	return ids
}
