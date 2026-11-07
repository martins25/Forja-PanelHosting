package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/m4rtins/forja/agent/internal/actions"
	"github.com/m4rtins/forja/agent/internal/audit"
)

type Config struct {
	SocketPath string
	AllowedUID uint32
	Registry   *actions.Registry
	Audit      *audit.Logger
	Logger     *slog.Logger
}

type Server struct {
	cfg      Config
	listener net.Listener
	srv      *http.Server
}

func New(cfg Config) *Server {
	mux := http.NewServeMux()
	s := &Server{cfg: cfg}

	mux.HandleFunc("POST /v1/actions/{name}", s.handleAction)

	s.srv = &http.Server{
		Handler: withPeerCred(cfg.AllowedUID, cfg.Logger, mux),
	}
	return s
}

func (s *Server) ListenAndServe() error {
	os.Remove(s.cfg.SocketPath)

	ln, err := net.Listen("unix", s.cfg.SocketPath)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	s.listener = ln

	if err := os.Chmod(s.cfg.SocketPath, 0660); err != nil {
		ln.Close()
		return fmt.Errorf("chmod socket: %w", err)
	}

	s.cfg.Logger.Info("agent listening", "socket", s.cfg.SocketPath)
	return s.srv.Serve(ln)
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.srv.Shutdown(ctx)
}

type contextKey string

const peerUIDKey contextKey = "peer_uid"

func withPeerCred(allowedUID uint32, logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		uid, ok := r.Context().Value(peerUIDKey).(uint32)
		if !ok {
			writeError(w, http.StatusForbidden, "PEER_CHECK_FAILED", "cannot verify peer credentials")
			return
		}
		if uid != allowedUID && uid != 0 {
			logger.Warn("rejected connection", "peer_uid", uid, "allowed_uid", allowedUID)
			writeError(w, http.StatusForbidden, "UNAUTHORIZED_PEER", "not authorized")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleAction(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")

	action, err := s.cfg.Registry.Get(name)
	if err != nil {
		writeError(w, http.StatusNotFound, "UNKNOWN_ACTION", err.Error())
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "READ_BODY", "cannot read request body")
		return
	}

	var params json.RawMessage
	if len(body) > 0 {
		params = json.RawMessage(body)
	}

	if err := action.Validate(params); err != nil {
		writeError(w, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}

	peerUID, _ := r.Context().Value(peerUIDKey).(uint32)
	actor := fmt.Sprintf("uid:%d", peerUID)

	// The audit entry is written after Execute so it records the real outcome.
	result, err := action.Execute(r.Context(), params)
	if err != nil {
		s.cfg.Audit.Log(audit.Event{
			Actor:     actor,
			ActorKind: "system",
			Action:    name,
			Result:    audit.ResultError,
			ErrorCode: "EXECUTE_FAILED",
		})
		s.cfg.Logger.Error("action failed", "action", name, "error", err)
		writeError(w, http.StatusInternalServerError, "EXECUTE", err.Error())
		return
	}

	s.cfg.Audit.Log(audit.Event{
		Actor:     actor,
		ActorKind: "system",
		Action:    name,
		Result:    audit.ResultOK,
	})

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "result": result})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// ConnContext returns a context.Context setter that extracts SO_PEERCRED
// from Unix socket connections. Use it as http.Server.ConnContext.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return ctx
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return ctx
	}
	var cred *unix.Ucred
	raw.Control(func(fd uintptr) {
		cred, err = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	})
	if err != nil || cred == nil {
		return ctx
	}

	return context.WithValue(ctx, peerUIDKey, cred.Uid)
}

// NewWithConnContext creates a Server that injects peer credentials into
// request contexts via SO_PEERCRED.
func NewWithConnContext(cfg Config) *Server {
	s := New(cfg)
	s.srv.ConnContext = ConnContext
	return s
}

// ListenAndServeWithPeerCred is a convenience that calls NewWithConnContext + ListenAndServe.
func ListenAndServeWithPeerCred(cfg Config) error {
	s := NewWithConnContext(cfg)
	return s.ListenAndServe()
}

// NewTestServer creates a server for testing, using a temporary socket
// and a pre-set peer UID injected into all request contexts.
func NewTestServer(cfg Config, fakeUID uint32) (*Server, string) {
	socketPath := cfg.SocketPath

	mux := http.NewServeMux()
	s := &Server{cfg: cfg}

	mux.HandleFunc("POST /v1/actions/{name}", s.handleAction)

	s.srv = &http.Server{
		Handler: withPeerCred(cfg.AllowedUID, cfg.Logger, mux),
		ConnContext: func(ctx context.Context, _ net.Conn) context.Context {
			return context.WithValue(ctx, peerUIDKey, fakeUID)
		},
	}

	return s, socketPath
}

// extractActionName extracts the action name from the URL path.
func extractActionName(path string) string {
	const prefix = "/v1/actions/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return path[len(prefix):]
}
