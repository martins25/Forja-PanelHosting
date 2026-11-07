package audit

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestLogWritesJSONL(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf)

	ts := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	err := logger.Log(Event{
		Timestamp:  ts,
		Actor:      "admin",
		ActorKind:  "user",
		Action:     "account.create",
		TargetType: "account",
		TargetID:   "test-site",
		Result:     ResultOK,
	})
	if err != nil {
		t.Fatal(err)
	}

	line := strings.TrimSpace(buf.String())
	var got Event
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("invalid JSON: %v\nline: %s", err, line)
	}

	if got.Actor != "admin" {
		t.Errorf("actor = %q, want 'admin'", got.Actor)
	}
	if got.Action != "account.create" {
		t.Errorf("action = %q, want 'account.create'", got.Action)
	}
	if got.Result != ResultOK {
		t.Errorf("result = %q, want 'ok'", got.Result)
	}
}

func TestLogSetsTimestamp(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf)

	before := time.Now().UTC()
	_ = logger.Log(Event{
		Actor:     "system",
		ActorKind: "system",
		Action:    "system.info",
		Result:    ResultOK,
	})
	after := time.Now().UTC()

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Timestamp.Before(before) || got.Timestamp.After(after) {
		t.Errorf("timestamp %v not between %v and %v", got.Timestamp, before, after)
	}
}

func TestLogErrorEvent(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf)

	_ = logger.Log(Event{
		Actor:     "admin",
		ActorKind: "user",
		Action:    "site.deploy",
		TargetType: "site",
		TargetID:   "my-site",
		Result:    ResultError,
		ErrorCode: "BUILD_FAILED",
	})

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Result != ResultError {
		t.Errorf("result = %q, want 'error'", got.Result)
	}
	if got.ErrorCode != "BUILD_FAILED" {
		t.Errorf("error_code = %q, want 'BUILD_FAILED'", got.ErrorCode)
	}
}

func TestLogMultipleEvents(t *testing.T) {
	var buf bytes.Buffer
	logger := New(&buf)

	for i := 0; i < 3; i++ {
		_ = logger.Log(Event{
			Actor:     "admin",
			ActorKind: "user",
			Action:    "test",
			Result:    ResultOK,
		})
	}

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 3 {
		t.Errorf("expected 3 lines, got %d", len(lines))
	}
}
