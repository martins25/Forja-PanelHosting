package actions

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/validate"
)

func newTestAccountCreate() (*AccountCreate, *osutil.FakeExecutor) {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	fake.LookupResult["fj-mysite"] = [2]int{1002, 1002}
	return &AccountCreate{OS: fake}, fake
}

func validParams() AccountCreateParams {
	return AccountCreateParams{
		Slug:      "demo",
		CPUMillis: 1000,
		MemoryMB:  512,
		DiskMB:    5000,
	}
}

func marshalParams(t *testing.T, p AccountCreateParams) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestAccountCreate_Name(t *testing.T) {
	a := &AccountCreate{}
	if a.Name() != "account.create" {
		t.Errorf("expected account.create, got %s", a.Name())
	}
}

func TestAccountCreate_Validate_OK(t *testing.T) {
	a := &AccountCreate{}
	if err := a.Validate(marshalParams(t, validParams())); err != nil {
		t.Errorf("valid params rejected: %v", err)
	}
}

func TestAccountCreate_Validate_InvalidSlug(t *testing.T) {
	a := &AccountCreate{}
	cases := []string{"", "A", "ab", "-abc", "a_b_c", strings.Repeat("a", 32)}
	for _, slug := range cases {
		p := validParams()
		p.Slug = slug
		if err := a.Validate(marshalParams(t, p)); err == nil {
			t.Errorf("expected error for slug %q", slug)
		}
	}
}

func TestAccountCreate_Validate_InvalidCPU(t *testing.T) {
	a := &AccountCreate{}
	for _, v := range []int{0, 50, 99, 16001, -1} {
		p := validParams()
		p.CPUMillis = v
		err := a.Validate(marshalParams(t, p))
		if err == nil {
			t.Errorf("expected error for cpu_millis=%d", v)
		}
		if !strings.Contains(err.Error(), "cpu_millis") {
			t.Errorf("error should mention cpu_millis: %v", err)
		}
	}
}

func TestAccountCreate_Validate_InvalidMemory(t *testing.T) {
	a := &AccountCreate{}
	for _, v := range []int{0, 63, 65537} {
		p := validParams()
		p.MemoryMB = v
		err := a.Validate(marshalParams(t, p))
		if err == nil {
			t.Errorf("expected error for memory_mb=%d", v)
		}
	}
}

func TestAccountCreate_Validate_InvalidDisk(t *testing.T) {
	a := &AccountCreate{}
	for _, v := range []int{0, 99, 1048577} {
		p := validParams()
		p.DiskMB = v
		err := a.Validate(marshalParams(t, p))
		if err == nil {
			t.Errorf("expected error for disk_mb=%d", v)
		}
	}
}

func TestAccountCreate_Validate_InvalidJSON(t *testing.T) {
	a := &AccountCreate{}
	if err := a.Validate(json.RawMessage(`not json`)); err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestAccountCreate_Validate_BoundaryValues(t *testing.T) {
	a := &AccountCreate{}

	p := AccountCreateParams{Slug: "abc", CPUMillis: 100, MemoryMB: 64, DiskMB: 100}
	if err := a.Validate(marshalParams(t, p)); err != nil {
		t.Errorf("min boundary rejected: %v", err)
	}

	p = AccountCreateParams{Slug: "abc", CPUMillis: 16000, MemoryMB: 65536, DiskMB: 1048576}
	if err := a.Validate(marshalParams(t, p)); err != nil {
		t.Errorf("max boundary rejected: %v", err)
	}
}

func TestAccountCreate_Execute_OK(t *testing.T) {
	action, fake := newTestAccountCreate()
	result, err := action.Execute(context.Background(), marshalParams(t, validParams()))
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}

	r, ok := result.(*AccountCreateResult)
	if !ok {
		t.Fatal("result is not *AccountCreateResult")
	}
	if r.LinuxUser != "fj-demo" {
		t.Errorf("expected fj-demo, got %s", r.LinuxUser)
	}
	if r.UID != 1001 {
		t.Errorf("expected uid 1001, got %d", r.UID)
	}
	if r.HomeDir != "/srv/forja/accounts/demo" {
		t.Errorf("expected /srv/forja/accounts/demo, got %s", r.HomeDir)
	}

	// Verify useradd was called
	runs := fake.CallsFor("Run")
	if len(runs) == 0 {
		t.Fatal("expected Run calls")
	}
	useraddArgs := runs[0].Args
	if useraddArgs[0] != "/usr/sbin/useradd" {
		t.Errorf("expected useradd, got %s", useraddArgs[0])
	}
	found := false
	privateGroup := false
	for _, arg := range useraddArgs {
		if arg == "fj-demo" {
			found = true
		}
		if arg == "--user-group" {
			privateGroup = true
		}
	}
	if !privateGroup {
		t.Error("useradd must create a private group (--user-group)")
	}
	if !found {
		t.Error("useradd args should contain fj-demo")
	}

	// Verify chown was called on home
	chowns := fake.CallsFor("Chown")
	if len(chowns) < 1 {
		t.Fatal("expected at least 1 Chown call")
	}
	if chowns[0].Args[0] != "/srv/forja/accounts/demo" {
		t.Errorf("first chown should be on home dir, got %s", chowns[0].Args[0])
	}

	// Verify subdirectories were created
	mkdirs := fake.CallsFor("MkdirAll")
	if len(mkdirs) != 4 {
		t.Errorf("expected 4 MkdirAll calls, got %d", len(mkdirs))
	}
	expectedDirs := []string{"sites", "logs", "tmp", "backups"}
	for i, dir := range expectedDirs {
		if i < len(mkdirs) {
			want := "/srv/forja/accounts/demo/" + dir
			if mkdirs[i].Args[0] != want {
				t.Errorf("mkdir[%d]: expected %s, got %s", i, want, mkdirs[i].Args[0])
			}
		}
	}

	// Verify podman network create
	runAs := fake.CallsFor("RunAs")
	if len(runAs) != 1 {
		t.Fatalf("expected 1 RunAs call, got %d", len(runAs))
	}
	if runAs[0].Args[0] != "fj-demo" {
		t.Errorf("RunAs should use fj-demo, got %s", runAs[0].Args[0])
	}
	if runAs[0].Args[1] != "podman" {
		t.Errorf("RunAs should call podman, got %s", runAs[0].Args[1])
	}

	// Verify subuid/subgid were written
	writes := fake.CallsFor("WriteFile")
	if len(writes) != 2 {
		t.Fatalf("expected 2 WriteFile calls, got %d", len(writes))
	}
	if writes[0].Args[0] != "/etc/subuid" {
		t.Errorf("expected /etc/subuid, got %s", writes[0].Args[0])
	}
	if writes[1].Args[0] != "/etc/subgid" {
		t.Errorf("expected /etc/subgid, got %s", writes[1].Args[0])
	}

	// Verify subuid content
	subuidData, ok := fake.WriteFileData["/etc/subuid"]
	if !ok {
		t.Fatal("subuid not written")
	}
	if !strings.Contains(string(subuidData), "fj-demo:100000:65536") {
		t.Errorf("subuid content unexpected: %s", string(subuidData))
	}
}

func TestAccountCreate_Execute_SubIDOffset(t *testing.T) {
	action, fake := newTestAccountCreate()

	// Pre-populate subuid with an existing entry
	fake.ReadFileData["/etc/subuid"] = []byte("fj-other:100000:65536\n")
	fake.ReadFileData["/etc/subgid"] = []byte("fj-other:100000:65536\n")

	_, err := action.Execute(context.Background(), marshalParams(t, validParams()))
	if err != nil {
		t.Fatalf("Execute failed: %v", err)
	}

	subuidData := string(fake.WriteFileData["/etc/subuid"])
	if !strings.Contains(subuidData, "fj-demo:165536:65536") {
		t.Errorf("expected offset 165536, got: %s", subuidData)
	}
}

func TestAccountCreate_Execute_UseraddFails(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	fake.RunFunc = func(_ context.Context, name string, args ...string) ([]byte, error) {
		return []byte("user exists"), validate.ErrInvalid
	}
	action := &AccountCreate{OS: fake}

	_, err := action.Execute(context.Background(), marshalParams(t, validParams()))
	if err == nil {
		t.Fatal("expected error when useradd fails")
	}
	if !strings.Contains(err.Error(), "useradd") {
		t.Errorf("error should mention useradd: %v", err)
	}
}

func TestAccountCreate_Execute_LookupFails(t *testing.T) {
	fake := osutil.NewFakeExecutor()
	// Don't populate LookupResult so it fails
	action := &AccountCreate{OS: fake}

	_, err := action.Execute(context.Background(), marshalParams(t, validParams()))
	if err == nil {
		t.Fatal("expected error when lookup fails")
	}
	if !strings.Contains(err.Error(), "lookup") {
		t.Errorf("error should mention lookup: %v", err)
	}
}

func TestAccountCreate_ImplementsAction(t *testing.T) {
	var _ Action = &AccountCreate{}
}
