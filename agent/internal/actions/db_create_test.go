package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBCreateParams() DBCreateParams {
	return DBCreateParams{
		AccountSlug: "demo",
		Engine:      "mariadb",
		DBName:      "mydb",
		DBUser:      "myuser",
		DBPassword:  "a1b2c3d4e5f6a7b8",
	}
}

func TestDBCreate_Name(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	if a.Name() != "db.create" {
		t.Errorf("expected db.create, got %s", a.Name())
	}
}

func TestDBCreate_Validate_OK(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBCreateParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBCreate_Validate_AllEngines(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	for _, engine := range []string{"mariadb", "mysql", "postgres"} {
		p := validDBCreateParams()
		p.Engine = engine
		params, _ := json.Marshal(p)
		if err := a.Validate(params); err != nil {
			t.Errorf("engine %q should be valid, got: %v", engine, err)
		}
	}
}

func TestDBCreate_Validate_InvalidEngine(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	p := validDBCreateParams()
	p.Engine = "sqlite"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid engine")
	}
}

func TestDBCreate_Validate_InvalidDBName(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	p := validDBCreateParams()
	p.DBName = "../etc"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid db_name")
	}
}

func TestDBCreate_Validate_EmptyPassword(t *testing.T) {
	a := &DBCreate{OS: &osutil.FakeExecutor{}}
	p := validDBCreateParams()
	p.DBPassword = ""
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty password")
	}
}

func TestDBCreate_Execute_MariaDB_NewContainer(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	inspectCalled := false
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "inspect") {
			inspectCalled = true
			return nil, &exec_error{}
		}
		return []byte("OK"), nil
	}

	a := &DBCreate{OS: fake}
	params, _ := json.Marshal(validDBCreateParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !inspectCalled {
		t.Error("expected podman inspect to be called")
	}

	r := result.(*DBCreateResult)
	if r.Engine != "mariadb" {
		t.Errorf("expected mariadb, got %s", r.Engine)
	}
	if r.ContainerName != "fj-demo-mariadb" {
		t.Errorf("expected fj-demo-mariadb, got %s", r.ContainerName)
	}

	var foundRun, foundCreateSQL bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "run --detach") && strings.Contains(args, "mariadb:11") {
			foundRun = true
			for _, want := range []string{"--memory 512m", "--cpus 1.0", "--pids-limit 128"} {
				if !strings.Contains(args, want) {
					t.Errorf("db podman run missing %q: %s", want, args)
				}
			}
		}
		if strings.Contains(args, "CREATE DATABASE") && strings.Contains(args, "mydb") {
			foundCreateSQL = true
		}
	}
	if !foundRun {
		t.Error("expected podman run with mariadb image")
	}
	if !foundCreateSQL {
		t.Error("expected CREATE DATABASE SQL")
	}
}

func TestDBCreate_Execute_Postgres(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		allArgs := strings.Join(args, " ")
		if strings.Contains(allArgs, "inspect") {
			return nil, &exec_error{}
		}
		return []byte("OK"), nil
	}

	p := validDBCreateParams()
	p.Engine = "postgres"
	a := &DBCreate{OS: fake}
	params, _ := json.Marshal(p)
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBCreateResult)
	if r.ContainerName != "fj-demo-postgres" {
		t.Errorf("expected fj-demo-postgres, got %s", r.ContainerName)
	}

	var foundPGRun, foundCreateUser, foundCreateDB bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "run --detach") && strings.Contains(args, "postgres:16") {
			foundPGRun = true
		}
		if strings.Contains(args, "CREATE USER") {
			foundCreateUser = true
		}
		if strings.Contains(args, "CREATE DATABASE") && strings.Contains(args, "OWNER") {
			foundCreateDB = true
		}
	}
	if !foundPGRun {
		t.Error("expected podman run with postgres image")
	}
	if !foundCreateUser {
		t.Error("expected CREATE USER for postgres")
	}
	if !foundCreateDB {
		t.Error("expected CREATE DATABASE with OWNER for postgres")
	}
}

func TestDBCreate_Execute_ExistingContainer(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	a := &DBCreate{OS: fake}
	params, _ := json.Marshal(validDBCreateParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := result.(*DBCreateResult)
	if r.ContainerName != "fj-demo-mariadb" {
		t.Errorf("expected fj-demo-mariadb, got %s", r.ContainerName)
	}

	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "run --detach") {
			t.Error("should not start a new container when one already exists")
		}
	}
}

type exec_error struct{}

func (e *exec_error) Error() string { return "exit status 1" }

func newEngineFake(existing bool) *osutil.FakeExecutor {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		if !existing && len(args) > 0 && args[0] == "inspect" && !strings.Contains(strings.Join(args, " "), "--format") {
			return nil, &exec_error{}
		}
		return []byte("OK"), nil
	}
	return fake
}

func TestDBCreate_Execute_RootPassword_AllEngines(t *testing.T) {
	cases := map[string]string{
		"mariadb":  "MARIADB_ROOT_PASSWORD=",
		"mysql":    "MYSQL_ROOT_PASSWORD=",
		"postgres": "POSTGRES_PASSWORD=",
	}
	for engine, envVar := range cases {
		fake := newEngineFake(false)
		p := validDBCreateParams()
		p.Engine = engine
		params, _ := json.Marshal(p)
		result, err := (&DBCreate{OS: fake}).Execute(context.Background(), params)
		if err != nil {
			t.Fatalf("%s: unexpected error: %v", engine, err)
		}
		r := result.(*DBCreateResult)
		if len(r.RootPassword) != 64 {
			t.Fatalf("%s: expected 32-byte hex root password, got %q", engine, r.RootPassword)
		}

		var envContent string
		for path, data := range fake.WriteFileData {
			if strings.HasSuffix(path, "root.env") {
				envContent = string(data)
			}
		}
		if !strings.Contains(envContent, envVar+r.RootPassword) {
			t.Errorf("%s: env file must carry %s, got %q", engine, envVar, envContent)
		}

		for _, c := range fake.Calls {
			joined := strings.Join(c.Args, " ")
			if strings.Contains(joined, "run --detach") {
				if strings.Contains(joined, r.RootPassword) {
					t.Errorf("%s: root password leaked into podman run argv: %s", engine, joined)
				}
				if !strings.Contains(joined, "--env-file") {
					t.Errorf("%s: expected --env-file, got: %s", engine, joined)
				}
			}
			for _, bad := range []string{"ALLOW_EMPTY", "HOST_AUTH_METHOD=trust", "trust"} {
				if strings.Contains(joined, bad) {
					t.Errorf("%s: insecure option %q still present: %s", engine, bad, joined)
				}
			}
		}
		// env-file is mode 0400 and removed after start
		var wrote, removed bool
		for _, c := range fake.Calls {
			if c.Method == "WriteFileAtomic" && strings.HasSuffix(c.Args[0], "root.env") && c.Args[1] == "0400" {
				wrote = true
			}
			if c.Method == "RunAs" && strings.Contains(strings.Join(c.Args, " "), "/usr/bin/rm -f -- ") && strings.Contains(strings.Join(c.Args, " "), "root.env") {
				removed = true
			}
		}
		if !wrote || !removed {
			t.Errorf("%s: expected 0400 env file written (%v) and removed (%v)", engine, wrote, removed)
		}
	}
}

func TestDBCreate_Execute_RootPasswordsAreUnique(t *testing.T) {
	a, b := "", ""
	for i := 0; i < 2; i++ {
		params, _ := json.Marshal(validDBCreateParams())
		res, err := (&DBCreate{OS: newEngineFake(false)}).Execute(context.Background(), params)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			a = res.(*DBCreateResult).RootPassword
		} else {
			b = res.(*DBCreateResult).RootPassword
		}
	}
	if a == b {
		t.Error("root passwords must be random per container")
	}
}

func TestDBCreate_Execute_MySQLClientAuthenticatesAsRoot(t *testing.T) {
	fake := newEngineFake(false)
	params, _ := json.Marshal(validDBCreateParams())
	result, err := (&DBCreate{OS: fake}).Execute(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	pw := result.(*DBCreateResult).RootPassword
	var found bool
	for path, data := range fake.WriteFileData {
		if strings.HasSuffix(path, "exec-auth.env") && string(data) == "MYSQL_PWD="+pw+"\n" {
			found = true
		}
	}
	if !found {
		t.Error("mysql exec must authenticate as root via an env file carrying the root password")
	}
	for _, c := range fake.Calls {
		if c.Method == "RunAs" && strings.Contains(strings.Join(c.Args, " "), "CREATE DATABASE") &&
			strings.Contains(strings.Join(c.Args, " "), pw) {
			t.Error("root password must not appear in the exec argv")
		}
	}
}

func TestDBCreate_Execute_ExistingContainer_ReturnsNoRootPassword(t *testing.T) {
	fake := newEngineFake(true)
	params, _ := json.Marshal(validDBCreateParams())
	result, err := (&DBCreate{OS: fake}).Execute(context.Background(), params)
	if err != nil {
		t.Fatal(err)
	}
	if rp := result.(*DBCreateResult).RootPassword; rp != "" {
		t.Errorf("existing container must not return a new root password, got %q", rp)
	}
}
