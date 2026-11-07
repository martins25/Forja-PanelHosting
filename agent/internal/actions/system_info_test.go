package actions

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSystemInfoValidate(t *testing.T) {
	a := &SystemInfo{}

	if err := a.Validate(nil); err != nil {
		t.Errorf("Validate(nil) should pass: %v", err)
	}
	if err := a.Validate(json.RawMessage(`{}`)); err != nil {
		t.Errorf("Validate({}) should pass: %v", err)
	}
	if err := a.Validate(json.RawMessage(`null`)); err != nil {
		t.Errorf("Validate(null) should pass: %v", err)
	}
	if err := a.Validate(json.RawMessage(`{"extra":"field"}`)); err == nil {
		t.Error("Validate with extra fields should fail")
	}
}

func TestSystemInfoExecute(t *testing.T) {
	a := &SystemInfo{}
	result, err := a.Execute(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}

	info, ok := result.(*SystemInfoResult)
	if !ok {
		t.Fatalf("result is %T, want *SystemInfoResult", result)
	}

	if info.CPUs < 1 {
		t.Error("CPUs should be at least 1")
	}
	if info.OS == "" {
		t.Error("OS should not be empty")
	}
	if info.Arch == "" {
		t.Error("Arch should not be empty")
	}
}
