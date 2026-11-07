package actions

import (
	"testing"
)

func TestRegistryGet(t *testing.T) {
	r := NewRegistry(&SystemInfo{})

	a, err := r.Get("system.info")
	if err != nil {
		t.Fatalf("Get(system.info) failed: %v", err)
	}
	if a.Name() != "system.info" {
		t.Errorf("Name() = %q, want 'system.info'", a.Name())
	}
}

func TestRegistryGetUnknown(t *testing.T) {
	r := NewRegistry(&SystemInfo{})

	_, err := r.Get("does.not.exist")
	if err == nil {
		t.Error("Get(unknown) should fail")
	}
}

func TestRegistryList(t *testing.T) {
	r := NewRegistry(&SystemInfo{})
	names := r.List()
	if len(names) != 1 {
		t.Errorf("expected 1 action, got %d", len(names))
	}
}
