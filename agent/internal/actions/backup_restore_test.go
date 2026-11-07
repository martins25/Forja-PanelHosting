package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestBackupRestore_Name(t *testing.T) {
	a := &BackupRestore{OS: osutil.NewFakeExecutor()}
	if a.Name() != "backup.restore" {
		t.Errorf("expected backup.restore, got %s", a.Name())
	}
}

func TestBackupRestore_Validate(t *testing.T) {
	a := &BackupRestore{}

	tests := []struct {
		name    string
		params  BackupRestoreParams
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid all",
			params: BackupRestoreParams{
				AccountSlug: "acme", ResticSnapshotID: "abc12345",
				Target: "all", Confirm: true,
			},
		},
		{
			name: "valid site target",
			params: BackupRestoreParams{
				AccountSlug: "acme", ResticSnapshotID: "abc12345",
				Target: "site:example.com", Confirm: true,
			},
		},
		{
			name: "reject without confirm",
			params: BackupRestoreParams{
				AccountSlug: "acme", ResticSnapshotID: "abc12345",
				Target: "all", Confirm: false,
			},
			wantErr: true, errMsg: "confirm must be true",
		},
		{
			name: "invalid snapshot id",
			params: BackupRestoreParams{
				AccountSlug: "acme", ResticSnapshotID: "not-hex!",
				Target: "all", Confirm: true,
			},
			wantErr: true,
		},
		{
			name: "invalid target",
			params: BackupRestoreParams{
				AccountSlug: "acme", ResticSnapshotID: "abc12345",
				Target: "invalid", Confirm: true,
			},
			wantErr: true,
		},
		{
			name: "invalid slug",
			params: BackupRestoreParams{
				AccountSlug: "../root", ResticSnapshotID: "abc12345",
				Target: "all", Confirm: true,
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw, _ := json.Marshal(tt.params)
			err := a.Validate(raw)
			if tt.wantErr && err == nil {
				t.Error("expected error")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if tt.errMsg != "" && err != nil && !strings.Contains(err.Error(), tt.errMsg) {
				t.Errorf("expected error containing %q, got: %v", tt.errMsg, err)
			}
		})
	}
}

func TestBackupRestore_RequiresConfirmInExecute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	a := &BackupRestore{OS: fake}

	params, _ := json.Marshal(BackupRestoreParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345",
		Target: "all", Confirm: false,
	})

	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when confirm is false")
	}
	if !strings.Contains(err.Error(), "confirm must be true") {
		t.Errorf("expected 'confirm must be true', got: %v", err)
	}
}

func TestBackupRestore_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	var stoppedContainers []string
	var resticRestoreCalled bool

	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/podman" && len(args) > 0 {
			switch args[0] {
			case "ps":
				return []byte("fj-acme-node-example\nfj-acme-mariadb\n"), nil
			case "stop":
				if len(args) > 2 {
					stoppedContainers = append(stoppedContainers, args[2])
				}
			}
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for _, a := range args {
				if a == "restore" {
					resticRestoreCalled = true
				}
			}
		}
		return nil, nil
	}

	a := &BackupRestore{OS: fake}
	params, _ := json.Marshal(BackupRestoreParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345",
		Target: "all", Confirm: true,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !resticRestoreCalled {
		t.Error("expected restic restore call")
	}

	res := result.(*BackupRestoreResult)
	if res.RestoredTo != "/srv/forja/accounts/acme" {
		t.Errorf("expected restore to /srv/forja/accounts/acme, got %s", res.RestoredTo)
	}
	if len(stoppedContainers) != 2 {
		t.Errorf("expected 2 stopped containers, got %d", len(stoppedContainers))
	}
}

func TestBackupRestore_AllTargetConfinesInclude(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	var restoreInclude string
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/podman" && len(args) > 0 && args[0] == "ps" {
			return []byte(""), nil
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for i, a := range args {
				if a == "--include" && i+1 < len(args) {
					restoreInclude = args[i+1]
				}
			}
		}
		return nil, nil
	}

	a := &BackupRestore{OS: fake}
	params, _ := json.Marshal(BackupRestoreParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345",
		Target: "all", Confirm: true,
	})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if restoreInclude != "/srv/forja/accounts/acme" {
		t.Errorf("expected --include /srv/forja/accounts/acme, got %q", restoreInclude)
	}
}

func TestBackupRestore_SiteTarget(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	var restoreInclude string
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/podman" && len(args) > 0 && args[0] == "ps" {
			return []byte(""), nil
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for i, a := range args {
				if a == "--include" && i+1 < len(args) {
					restoreInclude = args[i+1]
				}
			}
		}
		return nil, nil
	}

	a := &BackupRestore{OS: fake}
	params, _ := json.Marshal(BackupRestoreParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345",
		Target: "site:example.com", Confirm: true,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	res := result.(*BackupRestoreResult)
	expected := "/srv/forja/accounts/acme/sites/example.com"
	if res.RestoredTo != expected {
		t.Errorf("expected %s, got %s", expected, res.RestoredTo)
	}
	if restoreInclude != expected {
		t.Errorf("expected --include %s, got %s", expected, restoreInclude)
	}
}

func TestBackupRestore_RestartsContainersOnFailure(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	var startCalled bool
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/podman" && len(args) > 0 {
			switch args[0] {
			case "ps":
				return []byte("container1\n"), nil
			case "start":
				startCalled = true
			}
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			return nil, fmt.Errorf("restic failed")
		}
		return nil, nil
	}

	a := &BackupRestore{OS: fake}
	params, _ := json.Marshal(BackupRestoreParams{
		AccountSlug: "acme", ResticSnapshotID: "abc12345",
		Target: "all", Confirm: true,
	})

	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when restic restore fails")
	}
	if !startCalled {
		t.Error("should attempt to restart containers on failure")
	}
}
