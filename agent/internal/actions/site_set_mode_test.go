package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestSiteSetMode_Name(t *testing.T) {
	a := &SiteSetMode{OS: osutil.NewFakeExecutor()}
	if a.Name() != "site.set_mode" {
		t.Errorf("expected site.set_mode, got %s", a.Name())
	}
}

func TestSiteSetMode_Validate_OK(t *testing.T) {
	a := &SiteSetMode{OS: osutil.NewFakeExecutor()}
	for _, mode := range []string{"online", "maintenance", "disabled"} {
		params, _ := json.Marshal(SiteSetModeParams{
			AccountSlug: "demo",
			Domain:      "example.com",
			Mode:        mode,
		})
		if err := a.Validate(params); err != nil {
			t.Errorf("mode %q should be valid, got: %v", mode, err)
		}
	}
}

func TestSiteSetMode_Validate_InvalidMode(t *testing.T) {
	a := &SiteSetMode{OS: osutil.NewFakeExecutor()}
	params, _ := json.Marshal(SiteSetModeParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Mode:        "broken",
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid mode")
	}
}

func TestSiteSetMode_Execute_Disabled(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		all := strings.Join(append([]string{name}, args...), " ")
		if strings.Contains(all, "podman ps") {
			return []byte("abc123\ndef456\n"), nil
		}
		return nil, nil
	}
	a := &SiteSetMode{OS: fake}
	params, _ := json.Marshal(SiteSetModeParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Mode:        "disabled",
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteSetModeResult)
	if r.ContainersStopped != 2 {
		t.Errorf("expected 2 stopped, got %d", r.ContainersStopped)
	}

	calls := fake.CallsFor("RunAs")
	foundStop := false
	for _, c := range calls {
		all := strings.Join(c.Args, " ")
		if strings.Contains(all, "podman stop") && strings.Contains(all, "--time 30") {
			foundStop = true
		}
	}
	for _, c := range calls {
		if strings.Contains(strings.Join(c.Args, " "), "podman") && c.Args[1] != "/usr/bin/podman" {
			t.Errorf("podman must be invoked by absolute path, got %q", c.Args[1])
		}
	}
	if !foundStop {
		t.Error("expected podman stop with --time 30")
	}
}

func TestSiteSetMode_Execute_Online(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		all := strings.Join(append([]string{name}, args...), " ")
		if strings.Contains(all, "podman ps") && strings.Contains(all, "status=exited") {
			return []byte("abc123\n"), nil
		}
		return nil, nil
	}
	a := &SiteSetMode{OS: fake}
	params, _ := json.Marshal(SiteSetModeParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Mode:        "online",
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteSetModeResult)
	if r.ContainersStarted != 1 {
		t.Errorf("expected 1 started, got %d", r.ContainersStarted)
	}

	calls := fake.CallsFor("RunAs")
	foundStart := false
	for _, c := range calls {
		all := strings.Join(c.Args, " ")
		if strings.Contains(all, "podman start") {
			foundStart = true
		}
	}
	if !foundStart {
		t.Error("expected podman start")
	}
}

func TestSiteSetMode_Execute_Maintenance(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	a := &SiteSetMode{OS: fake}
	params, _ := json.Marshal(SiteSetModeParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Mode:        "maintenance",
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteSetModeResult)
	if r.ContainersStopped != 0 || r.ContainersStarted != 0 {
		t.Error("maintenance should be no-op")
	}

	calls := fake.CallsFor("RunAs")
	if len(calls) != 0 {
		t.Errorf("expected no RunAs calls for maintenance, got %d", len(calls))
	}
}

func TestSiteSetMode_Execute_DisabledNoContainers(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunAsFunc = func(_ context.Context, _ string, name string, args ...string) ([]byte, error) {
		return []byte(""), nil
	}
	a := &SiteSetMode{OS: fake}
	params, _ := json.Marshal(SiteSetModeParams{
		AccountSlug: "demo",
		Domain:      "example.com",
		Mode:        "disabled",
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteSetModeResult)
	if r.ContainersStopped != 0 {
		t.Errorf("expected 0 stopped when no containers, got %d", r.ContainersStopped)
	}
}
