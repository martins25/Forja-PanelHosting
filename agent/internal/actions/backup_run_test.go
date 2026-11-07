package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestBackupRun_Name(t *testing.T) {
	a := &BackupRun{OS: osutil.NewFakeExecutor()}
	if a.Name() != "backup.run" {
		t.Errorf("expected backup.run, got %s", a.Name())
	}
}

func TestBackupRun_Validate(t *testing.T) {
	a := &BackupRun{}

	tests := []struct {
		name    string
		params  BackupRunParams
		wantErr bool
	}{
		{"valid all", BackupRunParams{AccountSlug: "acme", Scope: "all"}, false},
		{"valid sites", BackupRunParams{AccountSlug: "acme", Scope: "sites"}, false},
		{"valid databases", BackupRunParams{AccountSlug: "acme", Scope: "databases"}, false},
		{"invalid scope", BackupRunParams{AccountSlug: "acme", Scope: "invalid"}, true},
		{"invalid slug", BackupRunParams{AccountSlug: "../etc", Scope: "all"}, true},
		{"valid with dbs", BackupRunParams{
			AccountSlug: "acme", Scope: "all",
			Databases: []DBInfo{{Engine: "mariadb", DBName: "test", DBUser: "root", DBPassword: "aabbccdd11223344"}},
		}, false},
		{"invalid db engine", BackupRunParams{
			AccountSlug: "acme", Scope: "all",
			Databases: []DBInfo{{Engine: "oracle", DBName: "test", DBUser: "root", DBPassword: "aabbccdd11223344"}},
		}, true},
		{"missing db user", BackupRunParams{
			AccountSlug: "acme", Scope: "all",
			Databases: []DBInfo{{Engine: "mariadb", DBName: "test", DBUser: "", DBPassword: "aabbccdd11223344"}},
		}, true},
		{"missing db password", BackupRunParams{
			AccountSlug: "acme", Scope: "all",
			Databases: []DBInfo{{Engine: "mariadb", DBName: "test", DBUser: "root", DBPassword: ""}},
		}, true},
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
		})
	}
}

func TestBackupRun_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	resticJSON := `{"message_type":"summary","snapshot_id":"abc12345","total_bytes_processed":1048576}`

	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("deadbeef")
	fake.ReadFileData["/var/lib/forja/restic/acme/config"] = []byte("repo config")

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for _, a := range args {
				if a == "backup" {
					return []byte(resticJSON), nil
				}
			}
		}
		return nil, nil
	}

	a := &BackupRun{OS: fake}
	params, _ := json.Marshal(BackupRunParams{AccountSlug: "acme", Scope: "all"})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	res := result.(*BackupRunResult)
	if res.ResticSnapshotID != "abc12345" {
		t.Errorf("expected snapshot abc12345, got %s", res.ResticSnapshotID)
	}
	if res.SizeBytes != 1048576 {
		t.Errorf("expected size 1048576, got %d", res.SizeBytes)
	}

	var foundBackup bool
	for _, c := range fake.CallsFor("Run") {
		allArgs := strings.Join(c.Args, " ")
		if strings.Contains(allArgs, "restic") && strings.Contains(allArgs, "backup") {
			foundBackup = true
		}
	}
	if !foundBackup {
		t.Error("expected restic backup call")
	}
}

func TestBackupRun_InitsRepoIfMissing(t *testing.T) {
	fake := osutil.NewFakeExecutor()

	var initCalled bool
	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for _, a := range args {
				if a == "init" {
					initCalled = true
					return []byte("created restic repository"), nil
				}
				if a == "backup" {
					return []byte(`{"message_type":"summary","snapshot_id":"def67890","total_bytes_processed":512}`), nil
				}
			}
		}
		return nil, nil
	}

	a := &BackupRun{OS: fake}
	params, _ := json.Marshal(BackupRunParams{AccountSlug: "acme", Scope: "sites"})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !initCalled {
		t.Error("expected restic init call for new repo")
	}
}

func TestBackupRun_DumpsDBsBeforeBackup(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}
	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("key")
	fake.ReadFileData["/var/lib/forja/restic/acme/config"] = []byte("cfg")

	var dumpCalled bool
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "mysqldump") {
			dumpCalled = true
			return []byte("-- dump data"), nil
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/restic" {
			for _, a := range args {
				if a == "backup" {
					return []byte(`{"message_type":"summary","snapshot_id":"aaa11111","total_bytes_processed":100}`), nil
				}
			}
		}
		return nil, nil
	}

	a := &BackupRun{OS: fake}
	params, _ := json.Marshal(BackupRunParams{
		AccountSlug: "acme",
		Scope:       "all",
		Databases: []DBInfo{
			{Engine: "mariadb", DBName: "mydb", DBUser: "root", DBPassword: "aabbccdd11223344"},
		},
	})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !dumpCalled {
		t.Error("expected database dump before backup")
	}
}

func TestBackupRun_SkipsDumpsForSitesScope(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("key")
	fake.ReadFileData["/var/lib/forja/restic/acme/config"] = []byte("cfg")

	var dumpCalled bool
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "mysqldump") || strings.Contains(allArgs, "pg_dump") {
			dumpCalled = true
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte(`{"message_type":"summary","snapshot_id":"bbb22222","total_bytes_processed":50}`), nil
	}

	a := &BackupRun{OS: fake}
	params, _ := json.Marshal(BackupRunParams{
		AccountSlug: "acme",
		Scope:       "sites",
		Databases: []DBInfo{
			{Engine: "postgres", DBName: "db1", DBUser: "admin", DBPassword: "aabbccddee112233"},
		},
	})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if dumpCalled {
		t.Error("should NOT dump databases when scope is sites")
	}
}

func TestParseResticOutput(t *testing.T) {
	t.Run("json format", func(t *testing.T) {
		out := `{"message_type":"summary","snapshot_id":"abc12345def","total_bytes_processed":2048}`
		id, size := parseResticOutput(out)
		if id != "abc12345def" {
			t.Errorf("expected abc12345def, got %s", id)
		}
		if size != 2048 {
			t.Errorf("expected 2048, got %d", size)
		}
	})

	t.Run("text format returns empty", func(t *testing.T) {
		out := "snapshot abcdef12 saved\nprocessed 10 files, 1.5 MiB"
		id, _ := parseResticOutput(out)
		if id != "" {
			t.Errorf("expected empty (text regex removed), got %s", id)
		}
	})

	t.Run("empty output", func(t *testing.T) {
		id, size := parseResticOutput("")
		if id != "" {
			t.Errorf("expected empty, got %s", id)
		}
		if size != 0 {
			t.Errorf("expected 0, got %d", size)
		}
	})
}

func TestBackupRun_KeyFileNotOverwritten(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.ReadFileData["/var/lib/forja/restic/acme.key"] = []byte("existingkey")
	fake.ReadFileData["/var/lib/forja/restic/acme/config"] = []byte("cfg")
	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte(`{"message_type":"summary","snapshot_id":"sec00002","total_bytes_processed":1}`), nil
	}

	a := &BackupRun{OS: fake}
	params, _ := json.Marshal(BackupRunParams{AccountSlug: "acme", Scope: "all"})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, overwritten := fake.WriteFileData["/var/lib/forja/restic/acme.key"]; overwritten {
		t.Error("should not overwrite existing key file")
	}
}
