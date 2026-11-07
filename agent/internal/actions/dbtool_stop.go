package actions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type DBToolStop struct {
	OS osutil.OSExecutor
}

type DBToolStopParams struct {
	AccountSlug string `json:"account_slug"`
	Tool        string `json:"tool"`
}

type DBToolStopResult struct {
	Stopped bool `json:"stopped"`
}

func (a *DBToolStop) Name() string { return "dbtool.stop" }

func (a *DBToolStop) Validate(params json.RawMessage) error {
	var p DBToolStopParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.WebTool(p.Tool); err != nil {
		return err
	}
	return nil
}

func (a *DBToolStop) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p DBToolStopParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	containerName := toolContainerName(p.AccountSlug, p.Tool)

	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "stop", "--time", "10", "--", containerName)
	a.OS.RunAs(ctx, linuxUser, "/usr/bin/podman", "rm", "--", containerName)

	return &DBToolStopResult{Stopped: true}, nil
}
