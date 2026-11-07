package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func validDBToolStopParams() DBToolStopParams {
	return DBToolStopParams{
		AccountSlug: "demo",
		Tool:        "phpmyadmin",
	}
}

func TestDBToolStop_Name(t *testing.T) {
	a := &DBToolStop{OS: &osutil.FakeExecutor{}}
	if a.Name() != "dbtool.stop" {
		t.Errorf("expected dbtool.stop, got %s", a.Name())
	}
}

func TestDBToolStop_Validate_OK(t *testing.T) {
	a := &DBToolStop{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(validDBToolStopParams())
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestDBToolStop_Validate_InvalidTool(t *testing.T) {
	a := &DBToolStop{OS: &osutil.FakeExecutor{}}
	p := validDBToolStopParams()
	p.Tool = "none"
	params, _ := json.Marshal(p)
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid tool")
	}
}

func TestDBToolStop_Execute(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(ctx context.Context, user string, name string, args ...string) ([]byte, error) {
		return []byte("OK"), nil
	}

	a := &DBToolStop{OS: fake}
	params, _ := json.Marshal(validDBToolStopParams())
	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*DBToolStopResult)
	if !r.Stopped {
		t.Error("expected stopped to be true")
	}

	var foundStop, foundRm bool
	for _, c := range fake.Calls {
		args := strings.Join(c.Args, " ")
		if strings.Contains(args, "stop") && strings.Contains(args, "fj-demo-phpmyadmin") {
			foundStop = true
		}
		if strings.Contains(args, " rm ") && strings.Contains(args, "fj-demo-phpmyadmin") {
			foundRm = true
		}
	}
	if !foundStop {
		t.Error("expected podman stop")
	}
	if !foundRm {
		t.Error("expected podman rm")
	}
}
