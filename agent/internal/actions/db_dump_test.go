package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBDumpParams() DBDumpParams {
	return DBDumpParams{
		AccountSlug: "demo",
		Engine:      "mariadb",
		DBName:      "mydb",
		DBUser:      "myuser",
		DBPassword:  "a1b2c3d4e5f6a7b8",
	}
}

func TestDBDump_Name(t *testing.T) {
	a := &DBDump{OS: &osutil.FakeExecutor{}}
	if a.Name() != "db.dump" {
		t.Errorf("expected db.dump, got %s", a.Name())
	}
}

func TestDBDump_Validate_OK(t *testing.T) {
	a := &DBDump{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBDumpParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBDump_Validate_EmptyPassword(t *testing.T) {
	a := &DBDump{OS: &osutil.FakeExecutor{}}
	p := validDBDumpParams()
	p.DBPassword = ""
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty password")
	}
}

func TestDBDump_Execute_MariaDB(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "mysqldump") {
			return []byte("-- MySQL dump"), nil
		}
		return []byte("OK"), nil
	}

	a := &DBDump{OS: fake}
	params, _ := json.Marshal(validDBDumpParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBDumpResult)
	if !strings.Contains(r.Path, "backups/db-mydb-") {
		t.Errorf("expected backup path, got %s", r.Path)
	}
	if !strings.HasSuffix(r.Path, ".sql") {
		t.Errorf("expected .sql extension, got %s", r.Path)
	}

	var foundDump bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "mysqldump") && strings.Contains(args, "mydb") {
			foundDump = true
			if strings.Contains(args, "--password=") {
				t.Error("password must not be passed as CLI arg; use MYSQL_PWD env var")
			}
			if !strings.Contains(args, "MYSQL_PWD=") {
				t.Error("expected MYSQL_PWD env var for mysqldump")
			}
		}
	}
	if !foundDump {
		t.Error("expected mysqldump command")
	}
}

func TestDBDump_Execute_Postgres(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "pg_dump") {
			return []byte("-- PostgreSQL dump"), nil
		}
		return []byte("OK"), nil
	}

	p := validDBDumpParams()
	p.Engine = "postgres"
	a := &DBDump{OS: fake}
	params, _ := json.Marshal(p)
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBDumpResult)
	if !strings.Contains(r.Path, "backups/db-mydb-") {
		t.Errorf("expected backup path, got %s", r.Path)
	}

	var foundDump bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "pg_dump") && strings.Contains(args, "mydb") {
			foundDump = true
		}
	}
	if !foundDump {
		t.Error("expected pg_dump command")
	}
}
