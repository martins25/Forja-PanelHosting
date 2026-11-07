import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

interface BackupRow {
  id: number;
  accountId: number;
  siteId: number | null;
  kind: "snapshot" | "export";
  resticSnapshotId: string | null;
  sizeBytes: number | null;
  includes: string | null;
  createdAt: string;
  status: string;
}

interface AccountOption {
  id: number;
  slug: string;
}

interface ExportResult extends BackupRow {
  download_token: string;
}

interface RestoreResult {
  ok: boolean;
  restored_to: string;
  restarted: string[];
}

const t = es.backups;
const tc = es.common;

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function Backups() {
  const { user } = useAuth();
  // Restoring is admin-only on the API; clients can create and download.
  const canRestore = user?.role === "admin";
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [backupsList, setBackupsList] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scope, setScope] = useState("all");
  const [downloadToken, setDownloadToken] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<BackupRow | null>(null);
  const [confirmInput, setConfirmInput] = useState("");
  const [restoreTarget, setRestoreTarget] = useState("all");

  const loadAccounts = useCallback(() => {
    return api<AccountOption[]>("/api/me/accounts")
      .then((accs) => {
        setAccounts(accs);
        if (accs.length > 0 && !selectedAccount) {
          setSelectedAccount(accs[0].id);
        }
      })
      .catch((err) => setError(String(err.message)))
      .finally(() => setLoading(false));
  }, [selectedAccount]);

  const loadBackups = useCallback(() => {
    if (!selectedAccount) return;
    api<BackupRow[]>(`/api/accounts/${selectedAccount}/backups`)
      .then(setBackupsList)
      .catch((err) => setError(String(err.message)));
  }, [selectedAccount]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    if (selectedAccount) {
      loadBackups();
    }
  }, [selectedAccount, loadBackups]);

  async function handleCreateBackup() {
    if (!selectedAccount) return;
    setCreating(true);
    setError("");
    setMessage("");
    try {
      await api<BackupRow>(`/api/accounts/${selectedAccount}/backups`, {
        method: "POST",
        body: JSON.stringify({ scope }),
      });
      setMessage(t.backupCreated);
      loadBackups();
    } catch {
      setError(t.errorCreating);
    } finally {
      setCreating(false);
    }
  }

  // Off-site copy: admin-only, copies the account's restic repo to the remote.
  async function handleSyncRemote() {
    if (!selectedAccount) return;
    setSyncing(true);
    setError("");
    setMessage("");
    try {
      const res = await api<{ ok: boolean; snapshotsCopied: number }>(
        `/api/accounts/${selectedAccount}/backups/sync-remote`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setMessage(t.syncRemoteDone.replace("{count}", String(res.snapshotsCopied)));
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "NO_REMOTE"
          ? t.syncRemoteNoRemote
          : t.syncRemoteError,
      );
    } finally {
      setSyncing(false);
    }
  }

  async function handleExport() {
    if (!selectedAccount) return;
    setExporting(true);
    setError("");
    setMessage("");
    setDownloadToken(null);
    try {
      const result = await api<ExportResult>(
        `/api/accounts/${selectedAccount}/backups/export`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      setDownloadToken(result.download_token);
      setMessage(t.exportReady);
      loadBackups();
    } catch {
      setError(t.errorExporting);
    } finally {
      setExporting(false);
    }
  }

  async function handleRestore() {
    if (!selectedAccount || !confirmRestore) return;
    if (confirmInput !== t.confirmRestoreWord) return;
    setRestoring(true);
    setError("");
    setMessage("");
    try {
      await api<RestoreResult>(
        `/api/accounts/${selectedAccount}/backups/${confirmRestore.id}/restore`,
        {
          method: "POST",
          body: JSON.stringify({ target: restoreTarget, confirm: true }),
        },
      );
      setMessage(t.restored);
      setConfirmRestore(null);
      setConfirmInput("");
    } catch {
      setError(t.errorRestoring);
    } finally {
      setRestoring(false);
    }
  }

  if (loading) return <div className="page-loading">{tc.loading}</div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>{t.title}</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      <div className="toolbar">
        <select
          value={selectedAccount ?? ""}
          onChange={(e) => setSelectedAccount(Number(e.target.value))}
          className="select"
        >
          <option value="" disabled>
            {t.selectAccount}
          </option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.slug}
            </option>
          ))}
        </select>

        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="select"
        >
          <option value="all">{t.scopeAll}</option>
          <option value="sites">{t.scopeSites}</option>
          <option value="databases">{t.scopeDatabases}</option>
        </select>

        <button
          className="btn btn-primary"
          onClick={handleCreateBackup}
          disabled={creating || !selectedAccount}
        >
          {creating ? t.creating : t.createBackup}
        </button>

        <button
          className="btn btn-secondary"
          onClick={handleExport}
          disabled={exporting || !selectedAccount}
        >
          {exporting ? t.exporting : t.export}
        </button>

        {canRestore && (
          <button
            className="btn btn-secondary"
            onClick={handleSyncRemote}
            disabled={syncing || !selectedAccount}
          >
            {syncing ? t.syncingRemote : t.syncRemote}
          </button>
        )}
      </div>

      {downloadToken && selectedAccount && (
        <div className="alert alert-info">
          <a
            href={`/api/accounts/${selectedAccount}/backups/export/${downloadToken}`}
            className="btn btn-link"
            download
          >
            {t.download}
          </a>
        </div>
      )}

      {backupsList.length === 0 ? (
        <p className="empty-state">{t.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t.date}</th>
              <th>{t.kind}</th>
              <th>{t.scope}</th>
              <th>{t.size}</th>
              <th>{t.status}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {backupsList.map((b) => (
              <tr key={b.id}>
                <td>{new Date(b.createdAt).toLocaleString()}</td>
                <td>{b.kind === "snapshot" ? t.snapshot : t.exportKind}</td>
                <td>{b.includes ?? "—"}</td>
                <td>{formatBytes(b.sizeBytes)}</td>
                <td>
                  <span className={`status-badge status-${b.status}`}>
                    {statusLabel(b.status)}
                  </span>
                </td>
                <td>
                  {canRestore &&
                    b.kind === "snapshot" &&
                    b.status === "completed" &&
                    b.resticSnapshotId && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => {
                          setConfirmRestore(b);
                          setConfirmInput("");
                          setRestoreTarget("all");
                        }}
                      >
                        {t.restore}
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmRestore && (
        <div className="modal-overlay" onClick={() => setConfirmRestore(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>{t.confirmRestoreTitle}</h2>
            <p>{t.confirmRestoreMessage}</p>

            <label className="form-label">
              {t.restoreTarget}
              <select
                value={restoreTarget}
                onChange={(e) => setRestoreTarget(e.target.value)}
                className="select"
              >
                <option value="all">{t.restoreTargetAll}</option>
              </select>
            </label>

            <label className="form-label">
              {t.confirmRestoreInput}
              <input
                type="text"
                className="input"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                placeholder={t.confirmRestoreWord}
              />
            </label>

            <div className="modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setConfirmRestore(null)}
              >
                {tc.cancel}
              </button>
              <button
                className="btn btn-danger"
                onClick={handleRestore}
                disabled={
                  confirmInput !== t.confirmRestoreWord || restoring
                }
              >
                {restoring ? t.restoring : t.restore}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: es.common.queued,
    running: es.common.running,
    completed: es.common.succeeded,
    failed: es.common.failed,
  };
  return map[status] ?? status;
}
