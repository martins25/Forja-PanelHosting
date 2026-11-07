package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBDropParams() DBDropParams {
	return DBDropParams{
		AccountSlug:  "demo",
		Engine:       "mariadb",
		DBName:       "mydb",
		DBUser:       "myuser",
		RemainingDBs: 1,
	}
}

func TestDBDrop_Name(t *testing.T) {
	a := &DBDrop{OS: &osutil.FakeExecutor{}}
	if a.Name() != "db.drop" {
		t.Errorf("expected db.drop, got %s", a.Name())
	}
}

func TestDBDrop_Validate_OK(t *testing.T) {
	a := &DBDrop{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBDropParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBDrop_Validate_InvalidEngine(t *testing.T) {
	a := &DBDrop{OS: &osutil.FakeExecutor{}}
	p := validDBDropParams()
	p.Engine = "sqlite"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid engine")
	}
}

func TestDBDrop_Validate_NegativeRemaining(t *testing.T) {
	a := &DBDrop{OS: &osutil.FakeExecutor{}}
	p := validDBDropParams()
	p.RemainingDBs = -1
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for negative remaining_dbs")
	}
}

func TestDBDrop_Execute_MariaDB_WithRemaining(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	a := &DBDrop{OS: fake}
	params, _ := json.Marshal(validDBDropParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBDropResult)
	if !r.Dropped {
		t.Error("expected dropped to be true")
	}

	var foundDropSQL bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "DROP DATABASE") && strings.Contains(args, "mydb") {
			foundDropSQL = true
		}
	}
	if !foundDropSQL {
		t.Error("expected DROP DATABASE SQL")
	}

	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if c.Method == "RunAs" && strings.Contains(args, "stop") && strings.Contains(args, "fj-demo-mariadb") {
			t.Error("should not stop container when remaining_dbs > 0")
		}
	}
}

func TestDBDrop_Execute_LastDB_StopsContainer(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	p := validDBDropParams()
	p.RemainingDBs = 0
	a := &DBDrop{OS: fake}
	params, _ := json.Marshal(p)
	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var foundStop, foundRm bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if c.Method == "RunAs" && strings.Contains(args, "stop") && strings.Contains(args, "fj-demo-mariadb") {
			foundStop = true
		}
		if c.Method == "RunAs" && strings.Contains(args, " rm ") && strings.Contains(args, "fj-demo-mariadb") {
			foundRm = true
		}
	}
	if !foundStop {
		t.Error("expected podman stop when remaining_dbs == 0")
	}
	if !foundRm {
		t.Error("expected podman rm when remaining_dbs == 0")
	}
}

func TestDBDrop_Execute_Postgres(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	p := validDBDropParams()
	p.Engine = "postgres"
	a := &DBDrop{OS: fake}
	params, _ := json.Marshal(p)
	_, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var foundDropDB, foundDropUser bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "DROP DATABASE") {
			foundDropDB = true
		}
		if strings.Contains(args, "DROP USER") {
			foundDropUser = true
		}
	}
	if !foundDropDB {
		t.Error("expected DROP DATABASE for postgres")
	}
	if !foundDropUser {
		t.Error("expected DROP USER for postgres")
	}
}
