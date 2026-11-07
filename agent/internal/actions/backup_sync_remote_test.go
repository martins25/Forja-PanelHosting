package actions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

const (
	testAccessKey = "AKIAIOSFODNN7EXAMPLE"
	testSecretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
)

func validRemote() RemoteParams {
	return RemoteParams{
		RemoteKind: "r2",
		Endpoint:   "https://abc123.r2.cloudflarestorage.com",
		Bucket:     "forja-backups",
		Region:     "auto",
		AccessKey:  testAccessKey,
		SecretKey:  testSecretKey,
	}
}

func remoteSyncParams(mut func(*BackupSyncRemoteParams)) json.RawMessage {
	p := BackupSyncRemoteParams{AccountSlug: "acme", RemoteParams: validRemote()}
	if mut != nil {
		mut(&p)
	}
	b, _ := json.Marshal(p)
	return b
}

// assertNoSecretsInArgs fails if any recorded call carries a credential in
// its argument list, and checks that the credentials went through the env.
func assertNoSecretsInArgs(t *testing.T, fake *osutil.FakeExecutor) {
	t.Helper()
	for _, c := range fake.Calls {
		joined := strings.Join(c.Args, " ")
		if strings.Contains(joined, testAccessKey) || strings.Contains(joined, testSecretKey) {
			t.Errorf("credential leaked into arguments of %s: %v", c.Method, c.Args)
		}
	}
}

func TestBackupSyncRemote_Name(t *testing.T) {
	if (&BackupSyncRemote{}).Name() != "backup.sync_remote" {
		t.Error("unexpected name")
	}
	if (&BackupRestoreRemote{}).Name() != "backup.restore_remote" {
		t.Error("unexpected name")
	}
	if (&BackupTestRemote{}).Name() != "backup.test_remote" {
		t.Error("unexpected name")
	}
}

func TestBackupSyncRemote_Validate(t *testing.T) {
	a := &BackupSyncRemote{}
	if err := a.Validate(remoteSyncParams(nil)); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}

	bad := map[string]func(*BackupSyncRemoteParams){
		"empty slug":          func(p *BackupSyncRemoteParams) { p.AccountSlug = "" },
		"slug traversal":      func(p *BackupSyncRemoteParams) { p.AccountSlug = "../etc" },
		"slug leading dash":   func(p *BackupSyncRemoteParams) { p.AccountSlug = "-acme" },
		"bad kind":            func(p *BackupSyncRemoteParams) { p.RemoteKind = "gcs" },
		"empty kind":          func(p *BackupSyncRemoteParams) { p.RemoteKind = "" },
		"http endpoint":       func(p *BackupSyncRemoteParams) { p.Endpoint = "http://s3.example.com" },
		"loopback endpoint":   func(p *BackupSyncRemoteParams) { p.Endpoint = "https://127.0.0.1" },
		"metadata endpoint":   func(p *BackupSyncRemoteParams) { p.Endpoint = "https://169.254.169.254" },
		"endpoint with path":  func(p *BackupSyncRemoteParams) { p.Endpoint = "https://s3.example.com/x" },
		"endpoint userinfo":   func(p *BackupSyncRemoteParams) { p.Endpoint = "https://u:p@s3.example.com" },
		"bucket with slash":   func(p *BackupSyncRemoteParams) { p.Bucket = "a/b" },
		"bucket traversal":    func(p *BackupSyncRemoteParams) { p.Bucket = "../x" },
		"bucket uppercase":    func(p *BackupSyncRemoteParams) { p.Bucket = "Forja" },
		"empty bucket":        func(p *BackupSyncRemoteParams) { p.Bucket = "" },
		"bad region":          func(p *BackupSyncRemoteParams) { p.Region = "eu west" },
		"empty access key":    func(p *BackupSyncRemoteParams) { p.AccessKey = "" },
		"access key newline":  func(p *BackupSyncRemoteParams) { p.AccessKey = "AKIAIOSFODNN7\nEXAMPLE" },
		"access key control":  func(p *BackupSyncRemoteParams) { p.AccessKey = "AKIA\x00IOSFODNN7EXAMPLE" },
		"secret key short":    func(p *BackupSyncRemoteParams) { p.SecretKey = "abc" },
		"secret key shell":    func(p *BackupSyncRemoteParams) { p.SecretKey = "abcdefghij;rm -rf /abcdef" },
		"secret key too long": func(p *BackupSyncRemoteParams) { p.SecretKey = strings.Repeat("a", 300) },
		"secret key unicode":  func(p *BackupSyncRemoteParams) { p.SecretKey = "abcdefghijklmnopñ" },
	}
	for name, mut := range bad {
		t.Run(name, func(t *testing.T) {
			err := a.Validate(remoteSyncParams(mut))
			if err == nil {
				t.Fatal("expected validation error")
			}
			if strings.Contains(err.Error(), testSecretKey) || strings.Contains(err.Error(), testAccessKey) {
				t.Error("validation error echoes a credential")
			}
		})
	}

	if err := a.Validate(json.RawMessage(`not json`)); err == nil {
		t.Error("expected error for malformed json")
	}
}

func TestBackupSyncRemote_ValidateErrorDoesNotEchoSecret(t *testing.T) {
	a := &BackupSyncRemote{}
	secret := "bad secret with spaces and ; stuff"
	err := a.Validate(remoteSyncParams(func(p *BackupSyncRemoteParams) { p.SecretKey = secret }))
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Errorf("secret echoed or no error: %v", err)
	}
}

func newSyncFake() *osutil.FakeExecutor {
	fake := osutil.NewFakeExecutor()
	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("deadbeef")
	fake.ReadFileData["/var/lib/forja/restic/acme/config"] = []byte("cfg")
	return fake
}

func TestBackupSyncRemote_Execute_ExistingRemote(t *testing.T) {
	fake := newSyncFake()
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		for _, a := range args {
			if a == "copy" {
				return []byte("snapshot 1a2b3c4d saved\nsnapshot 5e6f7a8b saved\nskipping snapshot 99999999, was already copied\n"), nil
			}
		}
		return nil, nil
	}

	res, err := (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := res.(*BackupSyncRemoteResult)
	if r.SnapshotsCopied != 2 {
		t.Errorf("expected 2 snapshots copied, got %d", r.SnapshotsCopied)
	}
	if r.Remote != "s3:https://abc123.r2.cloudflarestorage.com/forja-backups/acme" {
		t.Errorf("unexpected remote %q", r.Remote)
	}

	calls := fake.CallsFor("RunEnv")
	if len(calls) != 2 {
		t.Fatalf("expected cat config + copy, got %d calls: %v", len(calls), calls)
	}
	wantCopy := []string{
		resticBin, "--repo", "s3:https://abc123.r2.cloudflarestorage.com/forja-backups/acme",
		"--password-file", "/var/lib/forja/restic/acme.key",
		"copy", "--from-repo", "/var/lib/forja/restic/acme",
		"--from-password-file", "/var/lib/forja/restic/acme.key",
	}
	if strings.Join(calls[1].Args, "\x00") != strings.Join(wantCopy, "\x00") {
		t.Errorf("copy args = %v, want %v", calls[1].Args, wantCopy)
	}
	if len(fake.CallsFor("Run")) != 0 {
		t.Error("restic must run through RunEnv so credentials stay in the environment")
	}

	assertNoSecretsInArgs(t, fake)
	env := strings.Join(fake.EnvCalls[1], "\n")
	for _, want := range []string{
		"AWS_ACCESS_KEY_ID=" + testAccessKey,
		"AWS_SECRET_ACCESS_KEY=" + testSecretKey,
		"AWS_DEFAULT_REGION=auto",
	} {
		if !strings.Contains(env, want) {
			t.Errorf("env missing %s", strings.SplitN(want, "=", 2)[0])
		}
	}
}

func TestBackupSyncRemote_Execute_InitsMissingRemote(t *testing.T) {
	fake := newSyncFake()
	var initArgs []string
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		for _, a := range args {
			switch a {
			case "cat":
				return []byte("Is there a repository at the following location?"), errors.New("exit status 10")
			case "init":
				initArgs = args
			}
		}
		return nil, nil
	}

	if _, err := (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if initArgs == nil {
		t.Fatal("expected restic init on the remote")
	}
	joined := strings.Join(initArgs, " ")
	for _, want := range []string{"--from-repo /var/lib/forja/restic/acme", "--copy-chunker-params"} {
		if !strings.Contains(joined, want) {
			t.Errorf("init args missing %q: %s", want, joined)
		}
	}
	if len(fake.CallsFor("RunEnv")) != 3 {
		t.Errorf("expected cat, init, copy; got %d calls", len(fake.CallsFor("RunEnv")))
	}
	assertNoSecretsInArgs(t, fake)
}

func TestBackupSyncRemote_Execute_ErrorsAreScrubbed(t *testing.T) {
	fake := newSyncFake()
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		for _, a := range args {
			if a == "copy" {
				return []byte("auth failed for " + testAccessKey + " / " + testSecretKey), errors.New("exit status 1")
			}
		}
		return nil, nil
	}
	_, err := (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil))
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), testSecretKey) || strings.Contains(err.Error(), testAccessKey) {
		t.Errorf("error leaks credentials: %v", err)
	}
	if !strings.Contains(err.Error(), "***") {
		t.Errorf("expected redaction marker: %v", err)
	}
}

func TestBackupSyncRemote_Execute_InitFailure(t *testing.T) {
	fake := newSyncFake()
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		return []byte("denied"), errors.New("exit status 1")
	}
	if _, err := (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil)); err == nil {
		t.Fatal("expected error when remote cannot be opened or created")
	}
	if len(fake.CallsFor("RunEnv")) != 2 {
		t.Errorf("expected cat then init, got %d calls", len(fake.CallsFor("RunEnv")))
	}
}

func TestBackupSyncRemote_Execute_RequiresLocalRepo(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	_, err := (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil))
	if err == nil {
		t.Fatal("expected error without key")
	}

	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("k")
	_, err = (&BackupSyncRemote{OS: fake}).Execute(context.Background(), remoteSyncParams(nil))
	if err == nil || !strings.Contains(err.Error(), "run a backup first") {
		t.Errorf("expected missing repo error, got %v", err)
	}
	if len(fake.CallsFor("RunEnv")) != 0 {
		t.Error("restic must not run without a local repo")
	}
}

// ------------------------------------------------------------- restore_remote

func restoreRemoteParams(mut func(*BackupRestoreRemoteParams)) json.RawMessage {
	p := BackupRestoreRemoteParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345", Target: "all", Confirm: true,
		RemoteParams: validRemote(),
	}
	if mut != nil {
		mut(&p)
	}
	b, _ := json.Marshal(p)
	return b
}

func TestBackupRestoreRemote_Validate(t *testing.T) {
	a := &BackupRestoreRemote{}
	if err := a.Validate(restoreRemoteParams(nil)); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}
	bad := map[string]func(*BackupRestoreRemoteParams){
		"no confirm":      func(p *BackupRestoreRemoteParams) { p.Confirm = false },
		"bad snapshot":    func(p *BackupRestoreRemoteParams) { p.ResticSnapshotID = "--all" },
		"option snapshot": func(p *BackupRestoreRemoteParams) { p.ResticSnapshotID = "-abc12345" },
		"bad target":      func(p *BackupRestoreRemoteParams) { p.Target = "site:../../etc" },
		"bad slug":        func(p *BackupRestoreRemoteParams) { p.AccountSlug = "A/b" },
		"bad endpoint":    func(p *BackupRestoreRemoteParams) { p.Endpoint = "https://localhost" },
		"bad secret":      func(p *BackupRestoreRemoteParams) { p.SecretKey = "x" },
	}
	for name, mut := range bad {
		t.Run(name, func(t *testing.T) {
			if err := a.Validate(restoreRemoteParams(mut)); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestBackupRestoreRemote_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("deadbeef")
	// No local config: the repo must be created from the remote one.

	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) { return nil, nil }

	res, err := (&BackupRestoreRemote{OS: fake}).Execute(context.Background(), restoreRemoteParams(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.(*BackupRestoreResult).RestoredTo == "" {
		t.Errorf("unexpected restore result %+v", res)
	}

	envCalls := fake.CallsFor("RunEnv")
	if len(envCalls) != 2 {
		t.Fatalf("expected init + copy through RunEnv, got %d", len(envCalls))
	}
	if !strings.Contains(strings.Join(envCalls[0].Args, " "), "init --from-repo s3:https://abc123.r2.cloudflarestorage.com/forja-backups/acme") {
		t.Errorf("unexpected init: %v", envCalls[0].Args)
	}
	last := envCalls[1].Args
	if last[len(last)-1] != "abc12345" || !strings.Contains(strings.Join(last, " "), " copy --from-repo s3:") {
		t.Errorf("unexpected copy: %v", last)
	}

	// The regular restore ran afterwards, locally, without credentials.
	var restored bool
	for _, c := range fake.CallsFor("Run") {
		if c.Args[0] == resticBin && strings.Contains(strings.Join(c.Args, " "), "restore abc12345") {
			restored = true
		}
	}
	if !restored {
		t.Error("expected local restic restore after the copy")
	}
	assertNoSecretsInArgs(t, fake)
}

func TestBackupRestoreRemote_Execute_SkipsInitWhenLocalExists(t *testing.T) {
	fake := newSyncFake()
	if _, err := (&BackupRestoreRemote{OS: fake}).Execute(context.Background(), restoreRemoteParams(nil)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n := len(fake.CallsFor("RunEnv")); n != 1 {
		t.Errorf("expected only the copy, got %d RunEnv calls", n)
	}
}

func TestBackupRestoreRemote_Execute_NoKey(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	_, err := (&BackupRestoreRemote{OS: fake}).Execute(context.Background(), restoreRemoteParams(nil))
	if err == nil || !strings.Contains(err.Error(), "key") {
		t.Fatalf("expected missing key error, got %v", err)
	}
	if len(fake.Calls) != 1 { // only the ReadFile
		t.Errorf("nothing else should run: %v", fake.Calls)
	}
}

func TestBackupRestoreRemote_Execute_CopyFailureDoesNotRestore(t *testing.T) {
	fake := newSyncFake()
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		return []byte("boom " + testSecretKey), errors.New("exit status 1")
	}
	_, err := (&BackupRestoreRemote{OS: fake}).Execute(context.Background(), restoreRemoteParams(nil))
	if err == nil || strings.Contains(err.Error(), testSecretKey) {
		t.Fatalf("expected scrubbed error, got %v", err)
	}
	if len(fake.CallsFor("Run"))+len(fake.CallsFor("RunAs")) != 0 {
		t.Error("restore must not run if the copy failed")
	}
}

// ---------------------------------------------------------------- test_remote

func testRemoteParams(mut func(*RemoteParams)) json.RawMessage {
	p := validRemote()
	if mut != nil {
		mut(&p)
	}
	b, _ := json.Marshal(p)
	return b
}

func TestBackupTestRemote_Validate(t *testing.T) {
	a := &BackupTestRemote{}
	if err := a.Validate(testRemoteParams(nil)); err != nil {
		t.Fatalf("valid params rejected: %v", err)
	}
	for name, mut := range map[string]func(*RemoteParams){
		"kind":     func(p *RemoteParams) { p.RemoteKind = "ftp" },
		"endpoint": func(p *RemoteParams) { p.Endpoint = "https://10.0.0.1" },
		"bucket":   func(p *RemoteParams) { p.Bucket = "UP" },
		"region":   func(p *RemoteParams) { p.Region = "" },
		"access":   func(p *RemoteParams) { p.AccessKey = "a b" },
		"secret":   func(p *RemoteParams) { p.SecretKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			if err := a.Validate(testRemoteParams(mut)); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestBackupTestRemote_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	res, err := (&BackupTestRemote{OS: fake}).Execute(context.Background(), testRemoteParams(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.(*BackupTestRemoteResult).OK {
		t.Error("expected ok")
	}
	calls := fake.CallsFor("RunEnv")
	if len(calls) != 1 || calls[0].Args[len(calls[0].Args)-2] != "cat" {
		t.Fatalf("expected a single cat config, got %v", calls)
	}
	if !strings.Contains(strings.Join(calls[0].Args, " "), "/forja-backups/forja-connection-test") {
		t.Errorf("probe repo path wrong: %v", calls[0].Args)
	}
	assertNoSecretsInArgs(t, fake)
}

func TestBackupTestRemote_Execute_InitsProbeThenFails(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunEnvFunc = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		return []byte("Access Denied for " + testAccessKey), errors.New("exit status 1")
	}
	_, err := (&BackupTestRemote{OS: fake}).Execute(context.Background(), testRemoteParams(nil))
	if err == nil {
		t.Fatal("expected failure")
	}
	if strings.Contains(err.Error(), testAccessKey) {
		t.Errorf("error leaks access key: %v", err)
	}
	if len(fake.CallsFor("RunEnv")) != 2 {
		t.Errorf("expected cat + init, got %d", len(fake.CallsFor("RunEnv")))
	}
}
