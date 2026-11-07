package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/m4rtins/forja/agent/internal/actions"
	"github.com/m4rtins/forja/agent/internal/audit"
	"github.com/m4rtins/forja/agent/internal/caddy"
	"github.com/m4rtins/forja/agent/internal/cloudflare"
	"github.com/m4rtins/forja/agent/internal/health"
	"github.com/m4rtins/forja/agent/internal/osutil"
	"github.com/m4rtins/forja/agent/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	socketPath := envOr("FORJA_SOCKET", "/run/forja/agent.sock")
	auditPath := envOr("FORJA_AUDIT_LOG", "/var/lib/forja/audit.jsonl")
	allowedUID := uint32(envUID("FORJA_ALLOWED_UID", 0))

	auditLogger, err := audit.NewFile(auditPath)
	if err != nil {
		logger.Error("failed to open audit log", "path", auditPath, "error", err)
		os.Exit(1)
	}

	executor := &osutil.RealExecutor{}

	caddyClient := &caddy.RealClient{AdminURL: "http://127.0.0.1:2019"}
	healthChecker := &health.RealChecker{Retries: 10, Interval: 2 * time.Second}

	registry := actions.NewRegistry(
		&actions.SystemInfo{},
		&actions.AccountCreate{OS: executor},
		&actions.SiteCreate{OS: executor},
		&actions.SiteDeploy{OS: executor, Health: healthChecker},
		&actions.SiteSetMode{OS: executor},
		&actions.CaddySync{Caddy: caddyClient, OS: executor},
		&actions.LogsTail{OS: executor},
		&actions.CFConnectionApply{OS: executor},
		&actions.CFRoutesSync{CF: cloudflare.NewClient()},
		&actions.CertRequest{OS: executor, Caddy: caddyClient},
		&actions.CertRenew{OS: executor, Caddy: caddyClient},
		&actions.CertStatus{OS: executor},
		&actions.DBCreate{OS: executor},
		&actions.DBDrop{OS: executor},
		&actions.DBDump{OS: executor},
		&actions.DBSetPassword{OS: executor},
		&actions.DBToolStart{OS: executor},
		&actions.DBToolStop{OS: executor},
		&actions.FilesList{OS: executor},
		&actions.FilesRead{OS: executor},
		&actions.FilesWrite{OS: executor},
		&actions.FilesDelete{OS: executor},
		&actions.FilesMkdir{OS: executor},
		&actions.FilesUpload{OS: executor},
		&actions.BackupRun{OS: executor},
		&actions.BackupExport{OS: executor},
		&actions.BackupRestore{OS: executor},
		&actions.BackupSyncRemote{OS: executor},
		&actions.BackupRestoreRemote{OS: executor},
		&actions.BackupTestRemote{OS: executor},
	)

	cfg := server.Config{
		SocketPath: socketPath,
		AllowedUID: allowedUID,
		Registry:   registry,
		Audit:      auditLogger,
		Logger:     logger,
	}

	srv := server.NewWithConnContext(cfg)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		logger.Info("shutting down")
		srv.Shutdown(context.Background())
	}()

	logger.Info("starting forja-agent", "socket", socketPath, "allowed_uid", allowedUID)
	if err := srv.ListenAndServe(); err != nil {
		logger.Error("server error", "error", err)
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envUID(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return fallback
	}
	return n
}
