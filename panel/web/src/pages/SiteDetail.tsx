import { useEffect, useState, useRef, useCallback, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";
import { ModeBadge, DeployBadge } from "../components/Badges";
import SiteStats from "./SiteStats";
import SiteCertificate from "./SiteCertificate";

interface Domain {
  id: number;
  hostname: string;
  kind: string;
}

interface Deployment {
  id: number;
  siteId: number;
  commitSha: string;
  commitMessage: string | null;
  trigger: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  logPath: string | null;
}

interface SiteData {
  id: number;
  accountId: number;
  primaryDomain: string;
  runtime: string;
  runtimeVersion: string | null;
  source: string;
  repo: string | null;
  branch: string | null;
  installCmd: string | null;
  buildCmd: string | null;
  startCmd: string | null;
  publicDir: string | null;
  mode: string;
  internalPort: number | null;
  domains: Domain[];
  deployments: Deployment[];
}

interface EnvVar {
  id: number;
  siteId: number;
  key: string;
  maskedValue: string;
}

type Tab = "summary" | "deploys" | "logs" | "env" | "stats" | "certificate";

export function SiteDetail() {
  const { id } = useParams<{ id: string }>();
  const [site, setSite] = useState<SiteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("summary");

  const loadSite = useCallback(() => {
    api<SiteData>(`/api/sites/${id}`)
      .then(setSite)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadSite();
  }, [loadSite]);

  if (loading) return <div className="loading">{es.common.loading}</div>;
  if (error) return <div className="error-message">{error}</div>;
  if (!site) return null;

  const tabs: { key: Tab; label: string }[] = [
    { key: "summary", label: es.site.tabSummary },
    { key: "deploys", label: es.site.tabDeploys },
    { key: "logs", label: es.site.tabLogs },
    { key: "env", label: es.site.tabEnv },
    { key: "stats", label: es.site.tabStats },
    { key: "certificate", label: es.site.tabCertificate },
  ];

  return (
    <div>
      <div className="mb-4">
        <Link to="/" className="text-secondary text-sm">
          {es.sites.backToList}
        </Link>
      </div>
      <div className="site-header">
        <h1>{site.primaryDomain}</h1>
        <ModeBadge mode={site.mode} />
      </div>

      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "summary" && <SummaryTab site={site} onUpdate={loadSite} />}
      {tab === "deploys" && <DeploysTab site={site} />}
      {tab === "logs" && <LogsTab siteId={site.id} />}
      {tab === "env" && <EnvTab siteId={site.id} />}
      {tab === "stats" && <SiteStats siteId={site.id} />}
      {tab === "certificate" && <SiteCertificate siteId={site.id} />}
    </div>
  );
}

function SummaryTab({
  site,
  onUpdate,
}: {
  site: SiteData;
  onUpdate: () => void;
}) {
  const { user } = useAuth();
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState("");
  const [modeValue, setModeValue] = useState(site.mode);
  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState("");

  async function handleDeploy() {
    setDeploying(true);
    setDeployError("");
    try {
      await api(`/api/sites/${site.id}/deploy`, { method: "POST" });
      onUpdate();
    } catch (e) {
      setDeployError(
        e instanceof ApiError ? e.message : es.site.deployErrorGeneric,
      );
    } finally {
      setDeploying(false);
    }
  }

  async function handleModeChange() {
    if (modeValue === site.mode) return;
    setModeLoading(true);
    setModeError("");
    try {
      await api(`/api/sites/${site.id}/mode`, {
        method: "PATCH",
        body: JSON.stringify({ mode: modeValue }),
      });
      onUpdate();
    } catch (e) {
      setModeError(
        e instanceof ApiError ? e.message : es.site.modeErrorGeneric,
      );
    } finally {
      setModeLoading(false);
    }
  }

  return (
    <div>
      {deployError && <div className="error-message">{deployError}</div>}
      {modeError && <div className="error-message">{modeError}</div>}

      <div className="card mb-4">
        <div className="card-body">
          <div className="detail-grid">
            <span className="detail-label">{es.site.domain}</span>
            <span>{site.primaryDomain}</span>
            <span className="detail-label">{es.site.runtime}</span>
            <span className="text-mono">
              {site.runtime} {site.runtimeVersion}
            </span>
            <span className="detail-label">{es.site.repo}</span>
            <span className="text-mono">{site.repo ?? "—"}</span>
            <span className="detail-label">{es.site.branch}</span>
            <span className="text-mono">{site.branch ?? "—"}</span>
            <span className="detail-label">{es.site.installCmd}</span>
            <span className="text-mono">{site.installCmd ?? "—"}</span>
            <span className="detail-label">{es.site.buildCmd}</span>
            <span className="text-mono">{site.buildCmd || "—"}</span>
            <span className="detail-label">{es.site.startCmd}</span>
            <span className="text-mono">{site.startCmd ?? "—"}</span>
            {site.publicDir && (
              <>
                <span className="detail-label">{es.site.publicDir}</span>
                <span className="text-mono">{site.publicDir}</span>
              </>
            )}
            <span className="detail-label">{es.site.mode}</span>
            <span>
              <ModeBadge mode={site.mode} />
            </span>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          className="btn btn-primary"
          onClick={handleDeploy}
          disabled={deploying}
        >
          {deploying ? es.site.deploying : es.site.deploy}
        </button>
        <Link
          to={`/accounts/${site.accountId}/files`}
          className="btn btn-secondary"
        >
          {es.files.filesLink}
        </Link>
        {user?.role !== "admin" && (
          <Link
            to={`/sites/${site.id}/removal-request`}
            className="btn btn-secondary"
          >
            {es.removal.requestLink}
          </Link>
        )}

        <select
          className="form-select"
          style={{ width: "auto" }}
          value={modeValue}
          onChange={(e) => setModeValue(e.target.value)}
        >
          <option value="online">{es.site.modeOnline}</option>
          <option value="maintenance">{es.site.modeMaintenance}</option>
          {user?.role === "admin" && (
            <option value="disabled">{es.site.modeDisabled}</option>
          )}
        </select>
        <button
          className="btn btn-secondary"
          onClick={handleModeChange}
          disabled={modeLoading || modeValue === site.mode}
        >
          {es.site.changeMode}
        </button>
      </div>
    </div>
  );
}

function DeploysTab({ site }: { site: SiteData }) {
  const [logDeploy, setLogDeploy] = useState<Deployment | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  async function viewLog(deploy: Deployment) {
    setLogDeploy(deploy);
    setLogLoading(true);
    try {
      const data = await api<{ lines: string[] }>(
        `/api/sites/${site.id}/deployments/${deploy.id}/log`,
      );
      setLogLines(data.lines);
    } catch {
      setLogLines(["Error loading log"]);
    } finally {
      setLogLoading(false);
    }
  }

  function triggerLabel(trigger: string) {
    if (trigger === "webhook") return es.deploys.triggerWebhook;
    if (trigger === "rollback") return es.deploys.triggerRollback;
    return es.deploys.triggerManual;
  }

  return (
    <div>
      {site.deployments.length === 0 ? (
        <div className="empty-state">
          <p>{es.deploys.noDeploys}</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.deploys.commit}</th>
                  <th>{es.deploys.trigger}</th>
                  <th>{es.deploys.status}</th>
                  <th>{es.deploys.date}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {site.deployments.map((d) => (
                  <tr key={d.id}>
                    <td className="text-mono">
                      {d.commitSha?.slice(0, 7) ?? "—"}
                    </td>
                    <td>{triggerLabel(d.trigger)}</td>
                    <td>
                      <DeployBadge status={d.status} />
                    </td>
                    <td className="text-sm text-secondary">
                      {d.finishedAt
                        ? new Date(d.finishedAt).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      {d.logPath && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => viewLog(d)}
                        >
                          {es.deploys.viewLog}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {logDeploy && (
        <div className="modal-overlay" onClick={() => setLogDeploy(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>
                {es.deploys.buildLog} — {logDeploy.commitSha?.slice(0, 7)}
              </h3>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setLogDeploy(null)}
              >
                {es.deploys.close}
              </button>
            </div>
            <div className="modal-body">
              {logLoading ? (
                <div className="loading">{es.common.loading}</div>
              ) : (
                <div className="log-viewer">{logLines.join("\n")}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LogsTab({ siteId }: { siteId: number }) {
  const [source, setSource] = useState("app");
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(() => {
    api<{ lines: string[]; count: number }>(
      `/api/sites/${siteId}/logs?source=${source}&lines=200`,
    )
      .then((data) => {
        setLines(data.lines);
        if (logRef.current) {
          logRef.current.scrollTop = logRef.current.scrollHeight;
        }
      })
      .catch(() => {});
  }, [siteId, source]);

  useEffect(() => {
    fetchLogs();
    if (!paused) {
      intervalRef.current = setInterval(fetchLogs, 5000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchLogs, paused]);

  return (
    <div>
      <div className="log-toolbar">
        <select
          className="form-select"
          style={{ width: "auto" }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="app">{es.logs.sourceApp}</option>
          <option value="access">{es.logs.sourceAccess}</option>
        </select>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setPaused(!paused)}
        >
          {paused ? es.logs.resume : es.logs.pause}
        </button>
      </div>

      {lines.length === 0 ? (
        <div className="empty-state">
          <p>{es.logs.noLogs}</p>
        </div>
      ) : (
        <div className="log-viewer" ref={logRef}>
          {lines.join("\n")}
        </div>
      )}
    </div>
  );
}

function EnvTab({ siteId }: { siteId: number }) {
  const [vars, setVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingId, setSavingId] = useState<number | null>(null);

  const loadVars = useCallback(() => {
    api<EnvVar[]>(`/api/sites/${siteId}/env`)
      .then(setVars)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [siteId]);

  useEffect(() => {
    loadVars();
  }, [loadVars]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError("");
    try {
      await api(`/api/sites/${siteId}/env`, {
        method: "POST",
        body: JSON.stringify({ key: newKey, value: newValue }),
      });
      setNewKey("");
      setNewValue("");
      loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.env.errorAdding);
    } finally {
      setAdding(false);
    }
  }

  async function handleUpdate(varId: number) {
    setSavingId(varId);
    setError("");
    try {
      await api(`/api/sites/${siteId}/env/${varId}`, {
        method: "PATCH",
        body: JSON.stringify({ value: editValue }),
      });
      setEditingId(null);
      loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.env.errorUpdating);
    } finally {
      setSavingId(null);
    }
  }

  async function handleDelete(varId: number) {
    if (!confirm(es.env.confirmDelete)) return;
    setError("");
    try {
      await api(`/api/sites/${siteId}/env/${varId}`, { method: "DELETE" });
      loadVars();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.env.errorDeleting);
    }
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleAdd} className="flex items-center gap-2 mb-4">
        <input
          className="form-input"
          style={{ width: 200 }}
          placeholder={es.env.key}
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          pattern="^[A-Za-z_][A-Za-z0-9_]*$"
          required
        />
        <input
          className="form-input"
          style={{ flex: 1 }}
          placeholder={es.env.value}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          required
        />
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={adding}
        >
          {adding ? es.env.adding : es.env.addVariable}
        </button>
      </form>

      {vars.length === 0 ? (
        <div className="empty-state">
          <p>{es.env.noVars}</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.env.key}</th>
                  <th>{es.env.value}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vars.map((v) => (
                  <tr key={v.id}>
                    <td className="text-mono">{v.key}</td>
                    <td>
                      {editingId === v.id ? (
                        <input
                          className="form-input"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          autoFocus
                        />
                      ) : (
                        <span className="text-mono">{v.maskedValue}</span>
                      )}
                    </td>
                    <td>
                      <div className="env-actions">
                        {editingId === v.id ? (
                          <>
                            <button
                              className="btn btn-primary btn-sm"
                              onClick={() => handleUpdate(v.id)}
                              disabled={savingId === v.id}
                            >
                              {savingId === v.id ? es.env.saving : es.env.save}
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setEditingId(null)}
                            >
                              {es.common.cancel}
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setEditingId(v.id);
                                setEditValue("");
                              }}
                            >
                              {es.common.save}
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleDelete(v.id)}
                            >
                              {es.common.delete}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
