package actions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBToolStartParams() DBToolStartParams {
	return DBToolStartParams{
		AccountSlug: "demo",
		Tool:        "phpmyadmin",
		Engine:      "mariadb",
		DBHost:      "fj-demo-mariadb",
	}
}

func TestDBToolStart_Name(t *testing.T) {
	a := &DBToolStart{OS: &osutil.FakeExecutor{}}
	if a.Name() != "dbtool.start" {
		t.Errorf("expected dbtool.start, got %s", a.Name())
	}
}

func TestDBToolStart_Validate_OK(t *testing.T) {
	a := &DBToolStart{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBToolStartParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBToolStart_Validate_InvalidTool(t *testing.T) {
	a := &DBToolStart{OS: &osutil.FakeExecutor{}}
	p := validDBToolStartParams()
	p.Tool = "dbeaver"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid tool")
	}
}

func TestDBToolStart_Validate_EmptyDBHost(t *testing.T) {
	a := &DBToolStart{OS: &osutil.FakeExecutor{}}
	p := validDBToolStartParams()
	p.DBHost = ""
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for empty db_host")
	}
}

func TestDBToolStart_Execute_PHPMyAdmin(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("container-id"), nil
	}

	a := &DBToolStart{OS: fake}
	params, _ := json.Marshal(validDBToolStartParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBToolStartResult)
	if r.Port <= 0 {
		t.Errorf("expected positive port, got %d", r.Port)
	}
	if r.ContainerName != "fj-demo-phpmyadmin" {
		t.Errorf("expected fj-demo-phpmyadmin, got %s", r.ContainerName)
	}

	var foundRun bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "run --detach") && strings.Contains(args, "phpmyadmin:5") {
			foundRun = true
		}
	}
	if !foundRun {
		t.Error("expected podman run with phpmyadmin image")
	}
}

func TestDBToolStart_Execute_Adminer(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("container-id"), nil
	}

	p := validDBToolStartParams()
	p.Tool = "adminer"
	a := &DBToolStart{OS: fake}
	params, _ := json.Marshal(p)
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBToolStartResult)
	if r.ContainerName != "fj-demo-adminer" {
		t.Errorf("expected fj-demo-adminer, got %s", r.ContainerName)
	}
}

func TestDBToolStart_Execute_PgAdmin(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("container-id"), nil
	}

	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}

	p := validDBToolStartParams()
	p.Tool = "pgadmin"
	p.Engine = "postgres"
	a := &DBToolStart{OS: fake}
	params, _ := json.Marshal(p)
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBToolStartResult)
	if r.ContainerName != "fj-demo-pgadmin" {
		t.Errorf("expected fj-demo-pgadmin, got %s", r.ContainerName)
	}
	if len(r.AdminPassword) != 64 {
		t.Errorf("expected 64 hex char admin password, got %d chars", len(r.AdminPassword))
	}
	for _, c := range fake.Calls {
		all := c.Method + " " + strings.Join(c.Args, " ")
		if strings.Contains(all, "PGADMIN_DEFAULT_PASSWORD=") && c.Method != "WriteFileAtomic" {
			t.Errorf("password must not travel in argv: %s", all)
		}
		if strings.Contains(all, "PGADMIN_DEFAULT_PASSWORD=admin") {
			t.Error("default pgadmin password still in use")
		}
	}
}

func TestDBToolStart_Execute_PgAdminPasswordsDiffer(t *testing.T) {
	run := func() string {
		fake := osutil.NewFakeExecutor()
		fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
		fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
			return []byte("id"), nil
		}
		p := validDBToolStartParams()
		p.Tool = "pgadmin"
		params, _ := json.Marshal(p)
		res, err := (&DBToolStart{OS: fake}).Execute(context.Background(), params)
		if err != nil {
			t.Fatal(err)
		}
		return res.(*DBToolStartResult).AdminPassword
	}
	if run() == run() {
		t.Error("expected random password per start")
	}
}

func TestDBToolStart_Execute_PidsLimit(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("id"), nil
	}
	params, _ := json.Marshal(validDBToolStartParams())
	if _, err := (&DBToolStart{OS: fake}).Execute(context.Background(), params); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range fake.Calls {
		if strings.Contains(strings.Join(c.Args, " "), "run --detach") &&
			strings.Contains(strings.Join(c.Args, " "), "--pids-limit 64") {
			found = true
		}
	}
	if !found {
		t.Error("expected --pids-limit 64 in podman run")
	}
}

func TestDBToolStart_Execute_RetriesWhenPortTaken(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	var runs []string
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "run" {
			runs = append(runs, strings.Join(args, " "))
			if len(runs) < 3 {
				return []byte("Error: listen tcp 127.0.0.1:1234: bind: address already in use"), errors.New("exit status 126")
			}
		}
		return []byte("id"), nil
	}
	params, _ := json.Marshal(validDBToolStartParams())
	res, err := (&DBToolStart{OS: fake}).Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("expected success after retries: %v", err)
	}
	if len(runs) != 3 {
		t.Errorf("expected 3 podman run attempts, got %d", len(runs))
	}
	if res.(*DBToolStartResult).Port <= 0 {
		t.Error("expected a port")
	}
}

func TestDBToolStart_Execute_GivesUpAfterMaxAttempts(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	attempts := 0
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "run" {
			attempts++
			return []byte("address already in use"), errors.New("exit status 126")
		}
		return nil, nil
	}
	params, _ := json.Marshal(validDBToolStartParams())
	if _, err := (&DBToolStart{OS: fake}).Execute(context.Background(), params); err == nil {
		t.Fatal("expected error")
	}
	if attempts != 3 {
		t.Errorf("expected 3 attempts, got %d", attempts)
	}
}

func TestDBToolStart_Execute_NoRetryOnOtherErrors(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	attempts := 0
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "run" {
			attempts++
			return []byte("image not found"), errors.New("exit status 125")
		}
		return nil, nil
	}
	params, _ := json.Marshal(validDBToolStartParams())
	if _, err := (&DBToolStart{OS: fake}).Execute(context.Background(), params); err == nil {
		t.Fatal("expected error")
	}
	if attempts != 1 {
		t.Errorf("expected 1 attempt, got %d", attempts)
	}
}
