package actions

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestBackupExport_Name(t *testing.T) {
	a := &BackupExport{OS: osutil.NewFakeExecutor()}
	if a.Name() != "backup.export" {
		t.Errorf("expected backup.export, got %s", a.Name())
	}
}

func TestBackupExport_Validate(t *testing.T) {
	a := &BackupExport{}

	tests := []struct {
		name    string
		params  BackupExportParams
		wantErr bool
	}{
		{"valid without site", BackupExportParams{AccountSlug: "acme"}, false},
		{"valid with site", BackupExportParams{AccountSlug: "acme", SiteDomain: "example.com"}, false},
		{"valid with dbs", BackupExportParams{
			AccountSlug: "acme",
			Databases:   []DBInfo{{Engine: "mariadb", DBName: "mydb", DBUser: "root", DBPassword: "aabbccdd11223344"}},
		}, false},
		{"invalid slug", BackupExportParams{AccountSlug: "../etc"}, true},
		{"invalid domain", BackupExportParams{AccountSlug: "acme", SiteDomain: "not a domain!"}, true},
		{"missing db user", BackupExportParams{
			AccountSlug: "acme",
			Databases:   []DBInfo{{Engine: "mariadb", DBName: "mydb", DBUser: "", DBPassword: "aabbccdd11223344"}},
		}, true},
		{"missing db password", BackupExportParams{
			AccountSlug: "acme",
			Databases:   []DBInfo{{Engine: "mariadb", DBName: "mydb", DBUser: "root", DBPassword: ""}},
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

func TestBackupExport_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	homeBase := t.TempDir()
	if err := os.MkdirAll(homeBase+"/acme", 0755); err != nil {
		t.Fatal(err)
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/stat" {
			return []byte("4096"), nil
		}
		return nil, nil
	}

	a := &BackupExport{OS: fake, HomeBase: homeBase}
	params, _ := json.Marshal(BackupExportParams{AccountSlug: "acme"})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	res := result.(*BackupExportResult)
	if len(res.Token) != 64 {
		t.Errorf("expected 64-char token, got %d chars", len(res.Token))
	}
	if !strings.HasPrefix(res.Path, exportsBase) {
		t.Errorf("expected path under %s, got %s", exportsBase, res.Path)
	}
	if !strings.HasSuffix(res.Path, ".tar.gz") {
		t.Errorf("expected .tar.gz suffix, got %s", res.Path)
	}
	if res.SizeBytes != 4096 {
		t.Errorf("expected size 4096, got %d", res.SizeBytes)
	}

	var foundTar bool
	for _, c := range fake.CallsFor("Run") {
		allArgs := strings.Join(c.Args, " ")
		if strings.Contains(allArgs, "/usr/bin/tar") {
			foundTar = true
			if !strings.Contains(allArgs, "-C") {
				t.Error("tar should use -C flag")
			}
			if !strings.Contains(allArgs, "acme") {
				t.Error("tar -C should point to account home")
			}
		}
	}
	if !foundTar {
		t.Error("expected tar command")
	}
}

func TestBackupExport_WithSiteDomain(t *testing.T) {
	fake := osutil.NewFakeExecutor()

	homeBase := t.TempDir()
	if err := os.MkdirAll(homeBase+"/acme/sites/example.com", 0755); err != nil {
		t.Fatal(err)
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/stat" {
			return []byte("2048"), nil
		}
		return nil, nil
	}

	a := &BackupExport{OS: fake, HomeBase: homeBase}
	params, _ := json.Marshal(BackupExportParams{
		AccountSlug: "acme",
		SiteDomain:  "example.com",
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	res := result.(*BackupExportResult)
	if res.Token == "" {
		t.Error("expected non-empty token")
	}

	var tarSourceDir string
	for _, c := range fake.CallsFor("Run") {
		for i, a := range c.Args {
			if a == "-C" && i+1 < len(c.Args) {
				tarSourceDir = c.Args[i+1]
			}
		}
	}
	if !strings.Contains(tarSourceDir, "example.com") {
		t.Errorf("expected tar source to contain example.com, got %s", tarSourceDir)
	}
}

func TestBackupExport_DumpsDatabases(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-acme"] = [2]int{1001, 1001}

	homeBase := t.TempDir()
	if err := os.MkdirAll(homeBase+"/acme", 0755); err != nil {
		t.Fatal(err)
	}

	var dumpCalled bool
	fake.RunAsFunc = func(ctx context.Context, username string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "pg_dump") {
			dumpCalled = true
			return []byte("-- dump"), nil
		}
		return nil, nil
	}

	fake.RunFunc = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "/usr/bin/stat" {
			return []byte("1024"), nil
		}
		return nil, nil
	}

	a := &BackupExport{OS: fake, HomeBase: homeBase}
	params, _ := json.Marshal(BackupExportParams{
		AccountSlug: "acme",
		Databases: []DBInfo{
			{Engine: "postgres", DBName: "appdb", DBUser: "admin", DBPassword: "aabbccddee112233"},
		},
	})

	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !dumpCalled {
		t.Error("expected database dump before creating archive")
	}
}
