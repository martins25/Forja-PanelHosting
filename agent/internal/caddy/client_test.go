package caddy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFakeClient_RecordsCalls(t *testing.T) {
	fc := &FakeClient{}
	cfg := []byte(`{"test": true}`)
	if err := fc.LoadConfig(context.Background(), cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(fc.Calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(fc.Calls))
	}
	if string(fc.Calls[0]) != string(cfg) {
		t.Errorf("expected %q, got %q", cfg, fc.Calls[0])
	}
}

func TestFakeClient_ReturnsError(t *testing.T) {
	fc := &FakeClient{LoadErr: http.ErrServerClosed}
	err := fc.LoadConfig(context.Background(), []byte("{}"))
	if err != http.ErrServerClosed {
		t.Errorf("expected ErrServerClosed, got %v", err)
	}
}

func TestRealClient_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/load" {
			t.Errorf("expected /load, got %s", r.URL.Path)
		}
		if r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("expected application/json content-type")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &RealClient{AdminURL: srv.URL}
	if err := c.LoadConfig(context.Background(), []byte(`{}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRealClient_RejectsConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte("invalid config"))
	}))
	defer srv.Close()

	c := &RealClient{AdminURL: srv.URL}
	err := c.LoadConfig(context.Background(), []byte(`{bad}`))
	if err == nil {
		t.Fatal("expected error for rejected config")
	}
}

func TestRealClient_SetConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/config/apps/tls" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c := &RealClient{AdminURL: srv.URL}
	if err := c.SetConfig(context.Background(), "apps/tls", []byte(`{}`)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
