package health

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestFakeChecker_ReturnsNil(t *testing.T) {
	fc := &FakeChecker{}
	if err := fc.Check(context.Background(), "http://localhost:1234"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestFakeChecker_ReturnsError(t *testing.T) {
	fc := &FakeChecker{Err: http.ErrServerClosed}
	err := fc.Check(context.Background(), "http://localhost:1234")
	if err != http.ErrServerClosed {
		t.Errorf("expected ErrServerClosed, got %v", err)
	}
}

func TestRealChecker_SuccessImmediately(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &RealChecker{Retries: 3, Interval: 10 * time.Millisecond}
	if err := c.Check(context.Background(), srv.URL); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRealChecker_SuccessAfterRetries(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := calls.Add(1)
		if n < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := &RealChecker{Retries: 5, Interval: 10 * time.Millisecond}
	if err := c.Check(context.Background(), srv.URL); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := calls.Load(); got < 3 {
		t.Errorf("expected at least 3 calls, got %d", got)
	}
}

func TestRealChecker_ExhaustsRetries(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &RealChecker{Retries: 3, Interval: 10 * time.Millisecond}
	err := c.Check(context.Background(), srv.URL)
	if err == nil {
		t.Fatal("expected error after exhausting retries")
	}
}

func TestRealChecker_RespectsContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	c := &RealChecker{Retries: 10, Interval: 10 * time.Millisecond}
	err := c.Check(ctx, srv.URL)
	if err == nil {
		t.Fatal("expected context error")
	}
}
