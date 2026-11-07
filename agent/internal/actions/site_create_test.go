package actions

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

func TestSiteCreate_Name(t *testing.T) {
	a := &SiteCreate{OS: &osutil.FakeExecutor{}}
	if a.Name() != "site.create" {
		t.Errorf("expected site.create, got %s", a.Name())
	}
}

func TestSiteCreate_Validate_OK(t *testing.T) {
	a := &SiteCreate{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10000,
	})
	if err := a.Validate(params); err != nil {
		t.Fatalf("expected valid, got: %v", err)
	}
}

func TestSiteCreate_Validate_UnsupportedRuntime(t *testing.T) {
	a := &SiteCreate{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "php",
		RuntimeVersion: "8",
		InternalPort:   10000,
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for unsupported runtime")
	}
}

func TestSiteCreate_Validate_OddPort(t *testing.T) {
	a := &SiteCreate{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10001,
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for odd port")
	}
}

func TestSiteCreate_Validate_InvalidDomain(t *testing.T) {
	a := &SiteCreate{OS: &osutil.FakeExecutor{}}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "localhost",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10000,
	})
	if err := a.Validate(params); err == nil {
		t.Fatal("expected error for invalid domain")
	}
}

func TestSiteCreate_Execute_OK(t *testing.T) {
	fake := &osutil.FakeExecutor{
		LookupResult: map[string][2]int{"fj-demo": {1001, 1001}},
	}
	a := &SiteCreate{OS: fake}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10000,
	})

	result, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	r := result.(*SiteCreateResult)
	if r.SiteDir != "/srv/forja/accounts/demo/sites/example.com" {
		t.Errorf("unexpected site_dir: %s", r.SiteDir)
	}
	if r.PortBlue != 10000 {
		t.Errorf("expected port_blue=10000, got %d", r.PortBlue)
	}
	if r.PortGreen != 10001 {
		t.Errorf("expected port_green=10001, got %d", r.PortGreen)
	}

	mkdirCalls := fake.CallsFor("MkdirAll")
	if len(mkdirCalls) != 2 {
		t.Fatalf("expected 2 MkdirAll calls, got %d", len(mkdirCalls))
	}

	chownCalls := fake.CallsFor("Chown")
	if len(chownCalls) < 2 {
		t.Fatalf("expected at least 2 Chown calls, got %d", len(chownCalls))
	}

	runCalls := fake.CallsFor("Run")
	found := false
	for _, c := range runCalls {
		for _, arg := range c.Args {
			if arg == "enable-linger" {
				found = true
			}
		}
	}
	if !found {
		t.Error("expected loginctl enable-linger call")
	}
}

func TestSiteCreate_Execute_UserNotFound(t *testing.T) {
	fake := &osutil.FakeExecutor{
		LookupResult: map[string][2]int{},
	}
	a := &SiteCreate{OS: fake}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10000,
	})

	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error for missing user")
	}
}

func TestSiteCreate_Execute_MkdirFails(t *testing.T) {
	fake := &osutil.FakeExecutor{
		LookupResult: map[string][2]int{"fj-demo": {1001, 1001}},
		MkdirErr:     fmt.Errorf("disk full"),
	}
	a := &SiteCreate{OS: fake}
	params, _ := json.Marshal(SiteCreateParams{
		AccountSlug:    "demo",
		Domain:         "example.com",
		Runtime:        "node",
		RuntimeVersion: "22",
		InternalPort:   10000,
	})

	_, err := a.Execute(context.Background(), params)
	if err == nil {
		t.Fatal("expected error when mkdir fails")
	}
}
