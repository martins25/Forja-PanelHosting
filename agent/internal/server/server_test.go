package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/m4rtins/forja/agent/internal/actions"
	"github.com/m4rtins/forja/agent/internal/audit"
)

func testConfig(t *testing.T, allowedUID uint32) (Config, string) {
	t.Helper()
	dir := t.TempDir()
	socketPath := filepath.Join(dir, "agent.sock")
	auditPath := filepath.Join(dir, "audit.jsonl")

	auditLogger, err := audit.NewFile(auditPath)
	if err != nil {
		t.Fatal(err)
	}

	return Config{
		SocketPath: socketPath,
		AllowedUID: allowedUID,
		Registry:   actions.NewRegistry(&actions.SystemInfo{}),
		Audit:      auditLogger,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	}, socketPath
}

func startTestServer(t *testing.T, cfg Config, fakeUID uint32) string {
	t.Helper()
	s, socketPath := NewTestServer(cfg, fakeUID)

	os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	s.listener = ln

	go s.srv.Serve(ln)
	t.Cleanup(func() {
		s.srv.Close()
	})

	// Wait for socket to be ready
	for i := 0; i < 50; i++ {
		conn, err := net.Dial("unix", socketPath)
		if err == nil {
			conn.Close()
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	return socketPath
}

func unixClient(socketPath string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", socketPath)
			},
		},
	}
}

func TestSystemInfoEndpoint(t *testing.T) {
	cfg, _ := testConfig(t, 1000)
	socketPath := startTestServer(t, cfg, 1000)
	client := unixClient(socketPath)

	resp, err := client.Post("http://localhost/v1/actions/system.info", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}

	if result["ok"] != true {
		t.Errorf("result.ok = %v, want true", result["ok"])
	}
}

func TestUnknownAction(t *testing.T) {
	cfg, _ := testConfig(t, 1000)
	socketPath := startTestServer(t, cfg, 1000)
	client := unixClient(socketPath)

	resp, err := client.Post("http://localhost/v1/actions/does.not.exist", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestUnauthorizedPeer(t *testing.T) {
	cfg, _ := testConfig(t, 1000)
	socketPath := startTestServer(t, cfg, 9999) // wrong UID
	client := unixClient(socketPath)

	resp, err := client.Post("http://localhost/v1/actions/system.info", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

func TestRootAlwaysAllowed(t *testing.T) {
	cfg, _ := testConfig(t, 1000)
	socketPath := startTestServer(t, cfg, 0) // root
	client := unixClient(socketPath)

	resp, err := client.Post("http://localhost/v1/actions/system.info", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
}

type stubAction struct {
	name string
	err  error
	// seenAudit is called inside Execute to prove nothing was logged yet.
	seenAudit func() string
}

func (a *stubAction) Name() string                   { return a.name }
func (a *stubAction) Validate(json.RawMessage) error { return nil }
func (a *stubAction) Execute(context.Context, json.RawMessage) (any, error) {
	if a.seenAudit != nil {
		a.seenAudit()
	}
	if a.err != nil {
		return nil, a.err
	}
	return map[string]string{"done": "yes"}, nil
}

func readAudit(t *testing.T, socketPath string) []map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(filepath.Dir(socketPath), "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var events []map[string]any
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var e map[string]any
		if err := json.Unmarshal(line, &e); err != nil {
			t.Fatal(err)
		}
		events = append(events, e)
	}
	return events
}

func TestAudit_FailedActionIsNotLoggedAsOK(t *testing.T) {
	cfg, socketPath := testConfig(t, 1000)
	cfg.Registry = actions.NewRegistry(&stubAction{name: "test.fail", err: errors.New("boom")})
	startTestServer(t, cfg, 1000)

	resp, err := unixClient(socketPath).Post("http://localhost/v1/actions/test.fail", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}

	events := readAudit(t, socketPath)
	if len(events) != 1 {
		t.Fatalf("expected exactly 1 audit event, got %d: %v", len(events), events)
	}
	if events[0]["result"] != "error" || events[0]["action"] != "test.fail" {
		t.Errorf("unexpected audit event: %v", events[0])
	}
}

func TestAudit_SuccessfulActionLoggedOnceAfterExecute(t *testing.T) {
	cfg, socketPath := testConfig(t, 1000)
	var eventsDuringExecute int
	stub := &stubAction{name: "test.ok"}
	stub.seenAudit = func() string {
		data, _ := os.ReadFile(filepath.Join(filepath.Dir(socketPath), "audit.jsonl"))
		eventsDuringExecute = len(bytes.TrimSpace(data))
		return ""
	}
	cfg.Registry = actions.NewRegistry(stub)
	startTestServer(t, cfg, 1000)

	resp, err := unixClient(socketPath).Post("http://localhost/v1/actions/test.ok", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if eventsDuringExecute != 0 {
		t.Error("audit entry was written before Execute finished")
	}
	events := readAudit(t, socketPath)
	if len(events) != 1 || events[0]["result"] != "ok" {
		t.Errorf("unexpected audit events: %v", events)
	}
}
