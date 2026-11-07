package actions

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/m4rtins/forja/agent/internal/osutil"
)

const (
	testTunnelID  = "6ff42ae2-765d-4adf-8112-31c55c1551ef"
	testCFAccount = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
)

func makeTunnelToken(tunnelID string) string {
	payload := fmt.Sprintf(`{"a":%q,"t":%q,"s":"c2VjcmV0c2VjcmV0"}`, testCFAccount, tunnelID)
	return base64.StdEncoding.EncodeToString([]byte(payload))
}

func applyParams(mut func(*CFConnectionApplyParams)) json.RawMessage {
	p := CFConnectionApplyParams{
		AccountSlug:  "demo",
		ConnectionID: 7,
		State:        "present",
		TunnelID:     testTunnelID,
		TunnelToken:  makeTunnelToken(testTunnelID),
	}
	if mut != nil {
		mut(&p)
	}
	b, _ := json.Marshal(p)
	return b
}

func TestCFConnectionApply_Name(t *testing.T) {
	if (&CFConnectionApply{}).Name() != "cf.connection.apply" {
		t.Error("wrong name")
	}
}

func TestCFConnectionApply_Validate_OK(t *testing.T) {
	a := &CFConnectionApply{OS: osutil.NewFakeExecutor()}
	if err := a.Validate(applyParams(nil)); err != nil {
		t.Errorf("valid params rejected: %v", err)
	}
	absent := applyParams(func(p *CFConnectionApplyParams) {
		p.State, p.TunnelID, p.TunnelToken = "absent", "", ""
	})
	if err := a.Validate(absent); err != nil {
		t.Errorf("absent without token rejected: %v", err)
	}
}

func TestCFConnectionApply_Validate_Malicious(t *testing.T) {
	a := &CFConnectionApply{OS: osutil.NewFakeExecutor()}
	otherTunnel := "11111111-2222-3333-4444-555555555555"
	cases := map[string]func(*CFConnectionApplyParams){
		"slug traversal":      func(p *CFConnectionApplyParams) { p.AccountSlug = "../etc" },
		"slug leading dash":   func(p *CFConnectionApplyParams) { p.AccountSlug = "-rf" },
		"slug empty":          func(p *CFConnectionApplyParams) { p.AccountSlug = "" },
		"slug unicode":        func(p *CFConnectionApplyParams) { p.AccountSlug = "démo" },
		"connection zero":     func(p *CFConnectionApplyParams) { p.ConnectionID = 0 },
		"connection negative": func(p *CFConnectionApplyParams) { p.ConnectionID = -1 },
		"connection huge":     func(p *CFConnectionApplyParams) { p.ConnectionID = 1 << 40 },
		"state unknown":       func(p *CFConnectionApplyParams) { p.State = "restart" },
		"state empty":         func(p *CFConnectionApplyParams) { p.State = "" },
		"tunnel id injection": func(p *CFConnectionApplyParams) { p.TunnelID = testTunnelID + "; rm -rf /" },
		"tunnel id dash":      func(p *CFConnectionApplyParams) { p.TunnelID = "--privileged" },
		"token newline":       func(p *CFConnectionApplyParams) { p.TunnelToken += "\nOTHER=1" },
		"token dash arg":      func(p *CFConnectionApplyParams) { p.TunnelToken = "--entrypoint=/bin/sh" },
		"token control char":  func(p *CFConnectionApplyParams) { p.TunnelToken = "abc\x00def" + p.TunnelToken },
		"token too long":      func(p *CFConnectionApplyParams) { p.TunnelToken = strings.Repeat("A", 5000) },
		"token empty":         func(p *CFConnectionApplyParams) { p.TunnelToken = "" },
		"token not json": func(p *CFConnectionApplyParams) {
			p.TunnelToken = base64.StdEncoding.EncodeToString([]byte("not json at all, sorry"))
		},
		"token other tunnel":    func(p *CFConnectionApplyParams) { p.TunnelToken = makeTunnelToken(otherTunnel) },
		"tunnel id uppercase":   func(p *CFConnectionApplyParams) { p.TunnelID = strings.ToUpper(testTunnelID) },
		"absent bad slug":       func(p *CFConnectionApplyParams) { p.State = "absent"; p.AccountSlug = "a/b" },
		"absent bad connection": func(p *CFConnectionApplyParams) { p.State = "absent"; p.ConnectionID = 0 },
	}
	for name, mut := range cases {
		if err := a.Validate(applyParams(mut)); err == nil {
			t.Errorf("%s: expected validation error", name)
		}
	}
	if err := a.Validate(json.RawMessage(`{not json`)); err == nil {
		t.Error("malformed JSON should be rejected")
	}
}

func TestCFConnectionApply_Validate_ErrorDoesNotLeakToken(t *testing.T) {
	a := &CFConnectionApply{OS: osutil.NewFakeExecutor()}
	tok := makeTunnelToken("11111111-2222-3333-4444-555555555555")
	err := a.Validate(applyParams(func(p *CFConnectionApplyParams) { p.TunnelToken = tok }))
	if err == nil || strings.Contains(err.Error(), tok) {
		t.Errorf("error must exist and not contain the token: %v", err)
	}
}

func newApplyFake() *osutil.FakeExecutor {
	fake := osutil.NewFakeExecutor()
	fake.LookupResult["fj-demo"] = [2]int{1001, 1001}
	return fake
}

func TestCFConnectionApply_Execute_Present(t *testing.T) {
	fake := newApplyFake()
	a := &CFConnectionApply{OS: fake}

	res, err := a.Execute(context.Background(), applyParams(nil))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	r := res.(*CFConnectionApplyResult)
	if r.ContainerName != "cloudflared-7" || r.State != "present" {
		t.Errorf("result = %+v", r)
	}

	envPath := "/srv/forja/cloudflared/7.env"
	data, ok := fake.WriteFileData[envPath]
	if !ok {
		t.Fatalf("env file %s not written", envPath)
	}
	if string(data) != "TUNNEL_TOKEN="+makeTunnelToken(testTunnelID)+"\n" {
		t.Errorf("unexpected env file content")
	}

	// The token file is created atomically, root-owned with the account's group.
	atomic := fake.CallsFor("WriteFileAtomic")
	if len(atomic) != 1 || atomic[0].Args[0] != envPath || atomic[0].Args[1] != "0640" ||
		atomic[0].Args[2] != "0" || atomic[0].Args[3] != "1001" {
		t.Errorf("unexpected atomic write: %v", atomic)
	}
	if len(fake.CallsFor("WriteFile")) != 0 {
		t.Error("the token must never be written with a plain, inode-reusing WriteFile")
	}
	// Base dir: root:root 0711, verified/repaired by EnsureDir; nothing under an account home.
	dirs := fake.CallsFor("EnsureDir")
	if len(dirs) != 1 || dirs[0].Args[0] != cloudflaredEnvBase || dirs[0].Args[1] != "0711" ||
		dirs[0].Args[2] != "0" || dirs[0].Args[3] != "0" {
		t.Errorf("unexpected EnsureDir: %v", dirs)
	}
	for _, c := range append(fake.CallsFor("WriteFileAtomic"), fake.CallsFor("EnsureDir")...) {
		if strings.HasPrefix(c.Args[0], accountsBase) {
			t.Errorf("token material must never be placed under an account home: %s", c.Args[0])
		}
	}

	var run *osutil.Call
	for _, c := range fake.CallsFor("RunAs") {
		c := c
		if c.Args[0] != "fj-demo" {
			t.Errorf("command must run as the account user, got %s", c.Args[0])
		}
		if c.Args[1] == "/usr/bin/podman" && c.Args[2] == "run" {
			run = &c
		}
	}
	if run == nil {
		t.Fatal("podman run not called")
	}
	joined := strings.Join(run.Args, " ")
	for _, want := range []string{
		"--detach", "--name cloudflared-7", "--network fj-demo",
		"--env-file " + envPath, cloudflaredImage + " tunnel --no-autoupdate run",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("podman run missing %q in: %s", want, joined)
		}
	}
	if strings.Contains(joined, "--network host") || strings.Contains(joined, "--privileged") {
		t.Errorf("container must stay on the account network, unprivileged: %s", joined)
	}
	if strings.Contains(joined, makeTunnelToken(testTunnelID)) {
		t.Error("tunnel token must not appear in command arguments")
	}
}

func TestCFConnectionApply_Execute_Absent(t *testing.T) {
	fake := newApplyFake()
	a := &CFConnectionApply{OS: fake}
	params := applyParams(func(p *CFConnectionApplyParams) { p.State, p.TunnelID, p.TunnelToken = "absent", "", "" })

	res, err := a.Execute(context.Background(), params)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.(*CFConnectionApplyResult).State != "absent" {
		t.Error("state should be absent")
	}
	if len(fake.CallsFor("WriteFile")) != 0 {
		t.Error("absent must not write files")
	}
	var stopped, removedEnv bool
	for _, c := range fake.CallsFor("RunAs") {
		j := strings.Join(c.Args, " ")
		if strings.Contains(j, "podman stop") && strings.Contains(j, "cloudflared-7") {
			stopped = true
		}
		if strings.Contains(j, "podman run") {
			t.Error("absent must not start a container")
		}
		if strings.Contains(j, "/usr/bin/rm") {
			t.Error("the root-owned env file must not be removed as the account user")
		}
	}
	for _, c := range fake.CallsFor("Run") {
		if strings.Join(c.Args, " ") == "/usr/bin/rm -f -- /srv/forja/cloudflared/7.env" {
			removedEnv = true
		}
	}
	if !stopped || !removedEnv {
		t.Errorf("expected stop and env removal (stopped=%v removedEnv=%v)", stopped, removedEnv)
	}
}

func TestCFConnectionApply_Execute_UnknownUser(t *testing.T) {
	a := &CFConnectionApply{OS: osutil.NewFakeExecutor()}
	if _, err := a.Execute(context.Background(), applyParams(nil)); err == nil {
		t.Error("expected error when the account user does not exist")
	}
}

func TestCFConnectionApply_Execute_PodmanRunFails(t *testing.T) {
	fake := newApplyFake()
	fake.RunAsFunc = func(_ context.Context, _ string, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "run" {
			return []byte("boom"), errors.New("exit status 125")
		}
		return nil, nil
	}
	a := &CFConnectionApply{OS: fake}
	_, err := a.Execute(context.Background(), applyParams(nil))
	if err == nil || strings.Contains(err.Error(), makeTunnelToken(testTunnelID)) {
		t.Errorf("expected error without token, got %v", err)
	}
}

func TestCFConnectionApply_Execute_RefusesSharedGroup(t *testing.T) {
	fake := newApplyFake()
	fake.GroupNames = map[int]string{1001: "users"}
	a := &CFConnectionApply{OS: fake}

	_, err := a.Execute(context.Background(), applyParams(nil))
	if err == nil || !strings.Contains(err.Error(), "shared") {
		t.Fatalf("expected shared-group error, got %v", err)
	}
	if len(fake.CallsFor("WriteFileAtomic")) != 0 || len(fake.CallsFor("EnsureDir")) != 0 {
		t.Error("nothing may be written when the group is shared")
	}
	for _, c := range fake.CallsFor("RunAs") {
		if strings.Contains(strings.Join(c.Args, " "), "podman run") {
			t.Error("the container must not start")
		}
	}
}

func TestCFConnectionApply_Execute_EnsureDirFailure(t *testing.T) {
	fake := newApplyFake()
	fake.MkdirErr = errors.New("not a directory")
	a := &CFConnectionApply{OS: fake}
	if _, err := a.Execute(context.Background(), applyParams(nil)); err == nil {
		t.Fatal("expected error")
	}
	if len(fake.CallsFor("WriteFileAtomic")) != 0 {
		t.Error("must not write the token when the directory is not trustworthy")
	}
}
