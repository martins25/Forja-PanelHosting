import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

interface LinkedAccount {
  id: number;
  slug: string;
}

interface Connection {
  id: number;
  name: string;
  cfAccountId: string;
  tunnelId: string | null;
  status: string;
  apiTokenLast4: string | null;
  tunnelTokenLast4: string | null;
  accounts: LinkedAccount[];
}

interface AccountOption {
  id: number;
  slug: string;
}

interface SyncResult {
  domains: { hostname: string; status: string; error?: string }[];
  failed: number;
}

const emptyForm = {
  name: "",
  cf_account_id: "",
  api_token: "",
  tunnel_id: "",
  tunnel_token: "",
};

function statusBadgeClass(status: string) {
  if (status === "running") return "badge badge-success";
  if (status === "error") return "badge badge-danger";
  if (status === "stopped") return "badge badge-neutral";
  return "badge badge-warning";
}

export function CloudflareConnections() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const { user } = useAuth();
  // Linking accounts to a connection is an admin operation.
  const isAdmin = user?.role === "admin";
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [linkChoice, setLinkChoice] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    return Promise.all([
      api<Connection[]>("/api/cf-connections"),
      api<AccountOption[]>("/api/me/accounts"),
    ])
      .then(([conns, accs]) => {
        setConnections(conns);
        setAccounts(accs);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Secrets must not outlive the moment they are needed.
  function clearSecrets() {
    setForm((f) => ({ ...f, api_token: "", tunnel_token: "" }));
  }

  function toggleForm() {
    if (showForm) setForm(emptyForm);
    setShowForm((v) => !v);
  }

  function setField(field: keyof typeof emptyForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api("/api/cf-connections", {
        method: "POST",
        body: JSON.stringify(form),
      });
      // Tokens are never kept in the UI after being sent.
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      clearSecrets();
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setSaving(false);
    }
  }

  async function run(id: number, fn: () => Promise<void>) {
    setBusyId(id);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setBusyId(null);
    }
  }

  function handleApply(id: number) {
    return run(id, async () => {
      await api(`/api/cf-connections/${id}/apply`, { method: "POST" });
      setMessage(es.cf.applied);
    });
  }

  function handleSync(id: number) {
    return run(id, async () => {
      const res = await api<SyncResult>(`/api/cf-connections/${id}/sync-routes`, {
        method: "POST",
      });
      setMessage(
        res.failed === 0
          ? `${es.cf.synced}. ${es.cf.domainsOk.replace("{ok}", String(res.domains.length))}`
          : es.cf.syncedPartial.replace("{failed}", String(res.failed)),
      );
    });
  }

  function handleDelete(id: number) {
    if (!confirm(es.cf.confirmDelete)) return;
    return run(id, async () => {
      await api(`/api/cf-connections/${id}`, { method: "DELETE" });
    });
  }

  function handleLink(id: number) {
    const accountId = Number(linkChoice[id]);
    if (!accountId) return;
    return run(id, async () => {
      await api(`/api/cf-connections/${id}/accounts`, {
        method: "POST",
        body: JSON.stringify({ accountId }),
      });
      setLinkChoice((c) => ({ ...c, [id]: "" }));
    });
  }

  function handleUnlink(id: number, accountId: number) {
    if (!confirm(es.cf.confirmUnlink)) return;
    return run(id, async () => {
      await api(`/api/cf-connections/${id}/accounts/${accountId}`, {
        method: "DELETE",
      });
    });
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.cf.title}</h1>
        <button
          className="btn btn-primary"
          onClick={toggleForm}
        >
          {es.cf.newConnection}
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}
      {message && <div className="card mb-4"><div className="card-body">{message}</div></div>}

      {showForm && (
        <div className="card mb-4">
          <div className="card-body">
            <form onSubmit={handleCreate} autoComplete="off">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="cf-name">{es.cf.name}</label>
                  <input
                    id="cf-name"
                    className="form-input"
                    value={form.name}
                    onChange={(e) => setField("name", e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cf-account">{es.cf.cfAccountId}</label>
                  <input
                    id="cf-account"
                    className="form-input text-mono"
                    value={form.cf_account_id}
                    onChange={(e) => setField("cf_account_id", e.target.value)}
                    required
                  />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="cf-api-token">{es.cf.apiToken}</label>
                <input
                  id="cf-api-token"
                  className="form-input text-mono"
                  type="password"
                  autoComplete="new-password"
                  value={form.api_token}
                  onChange={(e) => setField("api_token", e.target.value)}
                  required
                />
                <div className="form-hint">{es.cf.apiTokenHint}</div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="cf-tunnel-id">{es.cf.tunnelId}</label>
                  <input
                    id="cf-tunnel-id"
                    className="form-input text-mono"
                    value={form.tunnel_id}
                    onChange={(e) => setField("tunnel_id", e.target.value)}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cf-tunnel-token">{es.cf.tunnelToken}</label>
                  <input
                    id="cf-tunnel-token"
                    className="form-input text-mono"
                    type="password"
                    autoComplete="new-password"
                    value={form.tunnel_token}
                    onChange={(e) => setField("tunnel_token", e.target.value)}
                    required
                  />
                </div>
              </div>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? es.cf.creating : es.cf.create}
              </button>
            </form>
          </div>
        </div>
      )}

      {connections.length === 0 ? (
        <div className="empty-state">{es.cf.empty}</div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.cf.name}</th>
                  <th>{es.cf.status}</th>
                  <th>{es.cf.tunnelId}</th>
                  <th>{es.cf.apiToken}</th>
                  <th>{es.cf.accounts}</th>
                  <th>{es.cf.actions}</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => {
                  const busy = busyId === c.id;
                  const linkedIds = new Set(c.accounts.map((a) => a.id));
                  const available = accounts.filter(
                    (a) => !linkedIds.has(a.id),
                  );
                  return (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>
                        <span className={statusBadgeClass(c.status)}>
                          {es.cf.statusLabels[c.status] ?? c.status}
                        </span>
                      </td>
                      <td className="text-mono text-sm">{c.tunnelId}</td>
                      <td className="text-mono text-sm">
                        {c.apiTokenLast4
                          ? es.cf.tokenStored.replace("{last4}", c.apiTokenLast4)
                          : ""}
                      </td>
                      <td>
                        {c.accounts.length === 0 ? (
                          <span className="text-secondary">{es.cf.noAccounts}</span>
                        ) : (
                          c.accounts.map((a) => (
                            <div key={a.id} className="flex items-center gap-2">
                              <span className="text-mono">{a.slug}</span>
                              {isAdmin && (
                                <button
                                  className="btn btn-ghost btn-sm"
                                  disabled={busy}
                                  onClick={() => handleUnlink(c.id, a.id)}
                                >
                                  {es.cf.unlink}
                                </button>
                              )}
                            </div>
                          ))
                        )}
                        {isAdmin && available.length > 0 && (
                          <div className="flex items-center gap-2 mt-2">
                            <select
                              className="form-select"
                              aria-label={`${es.cf.linkAccount} ${c.name}`}
                              value={linkChoice[c.id] ?? ""}
                              onChange={(e) =>
                                setLinkChoice((l) => ({ ...l, [c.id]: e.target.value }))
                              }
                            >
                              <option value="">{es.cf.selectAccount}</option>
                              {available.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.slug}
                                </option>
                              ))}
                            </select>
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={busy || !linkChoice[c.id]}
                              onClick={() => handleLink(c.id)}
                            >
                              {es.cf.link}
                            </button>
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <button
                            className="btn btn-primary btn-sm"
                            title={es.cf.applyHint}
                            disabled={busy}
                            onClick={() => handleApply(c.id)}
                          >
                            {es.cf.apply}
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            title={es.cf.syncHint}
                            disabled={busy}
                            onClick={() => handleSync(c.id)}
                          >
                            {es.cf.syncRoutes}
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={busy}
                            onClick={() => handleDelete(c.id)}
                          >
                            {es.cf.delete}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
