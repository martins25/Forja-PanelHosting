package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBSetPasswordParams() DBSetPasswordParams {
	return DBSetPasswordParams{
		AccountSlug: "demo",
		Engine:      "mariadb",
		DBUser:      "myuser",
		NewPassword: "b2c3d4e5f6a7b8c9",
	}
}

func TestDBSetPassword_Name(t *testing.T) {
	a := &DBSetPassword{OS: &osutil.FakeExecutor{}}
	if a.Name() != "db.set_password" {
		t.Errorf("expected db.set_password, got %s", a.Name())
	}
}

func TestDBSetPassword_Validate_OK(t *testing.T) {
	a := &DBSetPassword{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBSetPasswordParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBSetPassword_Validate_EmptyPassword(t *testing.T) {
	a := &DBSetPassword{OS: &osutil.FakeExecutor{}}
	p := validDBSetPasswordParams()
	p.NewPassword = ""
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty new_password")
	}
}

func TestDBSetPassword_Execute_MariaDB(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	a := &DBSetPassword{OS: fake}
	params, _ := json.Marshal(validDBSetPasswordParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBSetPasswordResult)
	if !r.Updated {
		t.Error("expected updated to be true")
	}

	var foundAlter bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "ALTER USER") && strings.Contains(args, "myuser") {
			foundAlter = true
		}
	}
	if !foundAlter {
		t.Error("expected ALTER USER SQL for mariadb")
	}
}

func TestDBSetPassword_Execute_Postgres(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	p := validDBSetPasswordParams()
	p.Engine = "postgres"
	a := &DBSetPassword{OS: fake}
	params, _ := json.Marshal(p)
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBSetPasswordResult)
	if !r.Updated {
		t.Error("expected updated to be true")
	}

	var foundAlter bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "ALTER ROLE") && strings.Contains(args, "myuser") {
			foundAlter = true
		}
	}
	if !foundAlter {
		t.Error("expected ALTER ROLE SQL for postgres")
	}
}
