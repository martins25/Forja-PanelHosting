package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

type SiteCreate struct {
	OS osutil.OSExecutor
}

type SiteCreateParams struct {
	AccountSlug    string `json:"account_slug"`
	Domain         string `json:"domain"`
	Runtime        string `json:"runtime"`
	RuntimeVersion string `json:"runtime_version"`
	InternalPort   int    `json:"internal_port"`
}

type SiteCreateResult struct {
	SiteDir   string `json:"site_dir"`
	PortBlue  int    `json:"port_blue"`
	PortGreen int    `json:"port_green"`
}

func (a *SiteCreate) Name() string { return "site.create" }

func (a *SiteCreate) Validate(params json.RawMessage) error {
	var p SiteCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.Hostname(p.Domain); err != nil {
		return err
	}
	if p.Runtime != "node" {
		return fmt.Errorf("%w: unsupported runtime %q", validate.ErrInvalid, p.Runtime)
	}
	if err := validate.NodeVersion(p.RuntimeVersion); err != nil {
		return err
	}
	if err := validate.Port(p.InternalPort); err != nil {
		return err
	}
	if p.InternalPort%2 != 0 {
		return fmt.Errorf("%w: internal_port must be even", validate.ErrInvalid)
	}
	return nil
}

func (a *SiteCreate) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p SiteCreateParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params: %w", err)
	}

	linuxUser := linuxUserPfx + p.AccountSlug
	homeDir := filepath.Join(accountsBase, p.AccountSlug)
	siteDir := filepath.Join(homeDir, "sites", p.Domain)

	uid, gid, err := a.OS.LookupUser(linuxUser)
	if err != nil {
		return nil, fmt.Errorf("account user not found: %w", err)
	}

	subdirs := []string{
		filepath.Join(siteDir, "app"),
		filepath.Join(siteDir, "storage"),
	}
	for _, dir := range subdirs {
		if err := a.OS.MkdirAll(dir, 0750); err != nil {
			return nil, fmt.Errorf("mkdir %s: %w", dir, err)
		}
		if err := a.OS.Chown(dir, uid, gid); err != nil {
			return nil, fmt.Errorf("chown %s: %w", dir, err)
		}
	}
	a.OS.Chown(siteDir, uid, gid)

	a.OS.Run(ctx, "/usr/bin/loginctl", "enable-linger", linuxUser)

	return &SiteCreateResult{
		SiteDir:   siteDir,
		PortBlue:  p.InternalPort,
		PortGreen: p.InternalPort + 1,
	}, nil
}
