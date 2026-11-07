package actions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

const (
	resticBin = "/usr/bin/restic"

	// remoteProbePrefix is the repository path used by backup.test_remote. It
	// holds no data; it only proves that the bucket is reachable and writable.
	remoteProbePrefix   = "forja-connection-test"
	remoteProbePassword = "forja-connection-test"

	syncRemoteTimeout = 4 * time.Hour
	testRemoteTimeout = 2 * time.Minute

	maxResticOutput = 500
)

// RemoteParams describes an S3-compatible backup backend. The credentials are
// handed to restic through environment variables only, never as arguments.
type RemoteParams struct {
	RemoteKind string `json:"remote_kind"`
	Endpoint   string `json:"endpoint"`
	Bucket     string `json:"bucket"`
	Region     string `json:"region"`
	AccessKey  string `json:"access_key"`
	SecretKey  string `json:"secret_key"`
}

func (r *RemoteParams) validate() error {
	if err := validate.RemoteKind(r.RemoteKind); err != nil {
		return err
	}
	if err := validate.S3Endpoint(r.Endpoint); err != nil {
		return err
	}
	if err := validate.S3Bucket(r.Bucket); err != nil {
		return err
	}
	if err := validate.S3Region(r.Region); err != nil {
		return err
	}
	if err := validate.S3AccessKey(r.AccessKey); err != nil {
		return err
	}
	return validate.S3SecretKey(r.SecretKey)
}

// repo returns the restic repository string for the given path prefix inside
// the bucket. It contains no credentials.
func (r *RemoteParams) repo(prefix string) string {
	return "s3:" + r.Endpoint + "/" + r.Bucket + "/" + prefix
}

func (r *RemoteParams) env() []string {
	return []string{
		"AWS_ACCESS_KEY_ID=" + r.AccessKey,
		"AWS_SECRET_ACCESS_KEY=" + r.SecretKey,
		"AWS_DEFAULT_REGION=" + r.Region,
	}
}

// resticError wraps a restic failure. The command output is included (it is
// the only diagnostic restic gives) but truncated and scrubbed of the
// credentials so they cannot reach the audit log or the API response.
func resticError(op string, out []byte, err error, secrets ...string) error {
	msg := strings.TrimSpace(string(out))
	for _, s := range secrets {
		if s != "" {
			msg = strings.ReplaceAll(msg, s, "***")
		}
	}
	if len(msg) > maxResticOutput {
		msg = msg[len(msg)-maxResticOutput:]
	}
	if msg == "" {
		return fmt.Errorf("%s: %w", op, err)
	}
	return fmt.Errorf("%s: %w: %s", op, err, msg)
}

// runRemote runs restic with the remote credentials in the environment.
func runRemote(ctx context.Context, osx osutil.OSExecutor, r *RemoteParams, extraEnv []string, op string, args ...string) ([]byte, error) {
	env := append(r.env(), extraEnv...)
	out, err := osx.RunEnv(ctx, env, resticBin, args...)
	if err != nil {
		return out, resticError(op, out, err, r.AccessKey, r.SecretKey)
	}
	return out, nil
}

// ---------------------------------------------------------------- sync_remote

type BackupSyncRemote struct {
	OS osutil.OSExecutor
}

type BackupSyncRemoteParams struct {
	AccountSlug string `json:"account_slug"`
	RemoteParams
}

type BackupSyncRemoteResult struct {
	Remote          string `json:"remote"`
	SnapshotsCopied int    `json:"snapshots_copied"`
}

func (a *BackupSyncRemote) Name() string { return "backup.sync_remote" }

func (a *BackupSyncRemote) Validate(params json.RawMessage) error {
	var p BackupSyncRemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("%w: invalid params", validate.ErrInvalid)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	return p.RemoteParams.validate()
}

func (a *BackupSyncRemote) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p BackupSyncRemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params")
	}
	ctx, cancel := context.WithTimeout(ctx, syncRemoteTimeout)
	defer cancel()

	localRepo := filepath.Join(resticBase, p.AccountSlug)
	keyFile := localRepo + ".key"
	if err := requireLocalRepo(a.OS, localRepo, keyFile); err != nil {
		return nil, err
	}

	remoteRepo := p.repo(p.AccountSlug)

	// The remote repository is created with the local one's chunker
	// parameters so that copied snapshots deduplicate, and it shares the
	// local password file: restoring on a new server only needs that key.
	if _, err := runRemote(ctx, a.OS, &p.RemoteParams, nil, "restic cat config",
		"--repo", remoteRepo, "--password-file", keyFile, "cat", "config",
	); err != nil {
		if _, err := runRemote(ctx, a.OS, &p.RemoteParams, nil, "restic init remote",
			"--repo", remoteRepo, "--password-file", keyFile,
			"init", "--from-repo", localRepo, "--from-password-file", keyFile,
			"--copy-chunker-params",
		); err != nil {
			return nil, err
		}
	}

	out, err := runRemote(ctx, a.OS, &p.RemoteParams, nil, "restic copy",
		"--repo", remoteRepo, "--password-file", keyFile,
		"copy", "--from-repo", localRepo, "--from-password-file", keyFile,
	)
	if err != nil {
		return nil, err
	}

	return &BackupSyncRemoteResult{
		Remote:          remoteRepo,
		SnapshotsCopied: countCopiedSnapshots(string(out)),
	}, nil
}

func countCopiedSnapshots(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "snapshot ") && strings.HasSuffix(line, " saved") {
			n++
		}
	}
	return n
}

func requireLocalRepo(osx osutil.OSExecutor, repoDir, keyFile string) error {
	if _, err := osx.ReadFile(keyFile); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("restic key for this account not found; restore it to %s first", keyFile)
		}
		return fmt.Errorf("read restic key: %w", err)
	}
	if _, err := osx.ReadFile(filepath.Join(repoDir, "config")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("no local backup repository for this account; run a backup first")
		}
		return fmt.Errorf("read restic repo: %w", err)
	}
	return nil
}

// -------------------------------------------------------------- restore_remote

type BackupRestoreRemote struct {
	OS osutil.OSExecutor
}

type BackupRestoreRemoteParams struct {
	AccountSlug      string `json:"account_slug"`
	ResticSnapshotID string `json:"restic_snapshot_id"`
	Target           string `json:"target"`
	Confirm          bool   `json:"confirm"`
	RemoteParams
}

func (a *BackupRestoreRemote) Name() string { return "backup.restore_remote" }

func (a *BackupRestoreRemote) Validate(params json.RawMessage) error {
	var p BackupRestoreRemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("%w: invalid params", validate.ErrInvalid)
	}
	if err := validate.Slug(p.AccountSlug); err != nil {
		return err
	}
	if err := validate.ResticSnapshotID(p.ResticSnapshotID); err != nil {
		return err
	}
	if err := validate.RestoreTarget(p.Target); err != nil {
		return err
	}
	if !p.Confirm {
		return fmt.Errorf("%w: confirm must be true to restore a backup", validate.ErrInvalid)
	}
	return p.RemoteParams.validate()
}

// Execute pulls one snapshot from the remote repository into the local one and
// then runs the regular backup.restore flow on it. On a new server the local
// repository does not exist yet: it is created from the remote one, which
// requires the account's restic key at <resticBase>/<slug>.key.
func (a *BackupRestoreRemote) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p BackupRestoreRemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params")
	}
	if !p.Confirm {
		return nil, errors.New("confirm must be true to restore a backup")
	}
	ctx, cancel := context.WithTimeout(ctx, syncRemoteTimeout)
	defer cancel()

	localRepo := filepath.Join(resticBase, p.AccountSlug)
	keyFile := localRepo + ".key"
	remoteRepo := p.repo(p.AccountSlug)

	if _, err := a.OS.ReadFile(keyFile); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("restic key for this account not found; restore it to %s first", keyFile)
		}
		return nil, fmt.Errorf("read restic key: %w", err)
	}

	if _, err := a.OS.ReadFile(filepath.Join(localRepo, "config")); errors.Is(err, os.ErrNotExist) {
		if err := a.OS.MkdirAll(localRepo, 0700); err != nil {
			return nil, fmt.Errorf("create local repo dir: %w", err)
		}
		if _, err := runRemote(ctx, a.OS, &p.RemoteParams, nil, "restic init local",
			"--repo", localRepo, "--password-file", keyFile,
			"init", "--from-repo", remoteRepo, "--from-password-file", keyFile,
			"--copy-chunker-params",
		); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, fmt.Errorf("read restic repo: %w", err)
	}

	if _, err := runRemote(ctx, a.OS, &p.RemoteParams, nil, "restic copy from remote",
		"--repo", localRepo, "--password-file", keyFile,
		"copy", "--from-repo", remoteRepo, "--from-password-file", keyFile,
		p.ResticSnapshotID,
	); err != nil {
		return nil, err
	}

	restoreParams, _ := json.Marshal(BackupRestoreParams{
		AccountSlug:      p.AccountSlug,
		ResticSnapshotID: p.ResticSnapshotID,
		Target:           p.Target,
		Confirm:          true,
	})
	restorer := &BackupRestore{OS: a.OS}
	if err := restorer.Validate(restoreParams); err != nil {
		return nil, err
	}
	return restorer.Execute(ctx, restoreParams)
}

// ----------------------------------------------------------------- test_remote

type BackupTestRemote struct {
	OS osutil.OSExecutor
}

type BackupTestRemoteResult struct {
	OK bool `json:"ok"`
}

func (a *BackupTestRemote) Name() string { return "backup.test_remote" }

func (a *BackupTestRemote) Validate(params json.RawMessage) error {
	var p RemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return fmt.Errorf("%w: invalid params", validate.ErrInvalid)
	}
	return p.validate()
}

// Execute proves that the bucket is reachable and writable by opening, or
// creating if absent, a data-less probe repository next to the account ones.
func (a *BackupTestRemote) Execute(ctx context.Context, params json.RawMessage) (any, error) {
	var p RemoteParams
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("invalid params")
	}
	ctx, cancel := context.WithTimeout(ctx, testRemoteTimeout)
	defer cancel()

	repo := p.repo(remoteProbePrefix)
	env := []string{"RESTIC_PASSWORD=" + remoteProbePassword}

	if _, err := runRemote(ctx, a.OS, &p, env, "restic cat config",
		"--repo", repo, "cat", "config",
	); err != nil {
		if _, err := runRemote(ctx, a.OS, &p, env, "restic init probe",
			"--repo", repo, "init",
		); err != nil {
			return nil, err
		}
	}
	return &BackupTestRemoteResult{OK: true}, nil
}
