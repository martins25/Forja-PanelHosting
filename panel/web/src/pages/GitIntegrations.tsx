import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

interface Integration {
  id: number;
  provider: "github" | "gitea";
  baseUrl: string | null;
  credentialsLast4: string;
  sitesCount: number;
}

const emptyForm = { provider: "gitea", baseUrl: "", credentials: "" };

export function GitIntegrations() {
  const { user } = useAuth();
  // Gitea instances are admin-only; clients can only add GitHub tokens.
  const isAdmin = user?.role === "admin";
  const providers = isAdmin ? ["github", "gitea"] : ["github"];
  const blankForm = { ...emptyForm, provider: isAdmin ? "gitea" : "github" };
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    return api<Integration[]>("/api/git-integrations")
      .then(setIntegrations)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleForm() {
    if (showForm) setForm(blankForm);
    setShowForm((v) => !v);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api("/api/git-integrations", {
        method: "POST",
        body: JSON.stringify({
          provider: form.provider,
          baseUrl: form.provider === "gitea" ? form.baseUrl : undefined,
          credentials: form.credentials,
        }),
      });
      // The token is never kept in the UI after being sent.
      setForm(blankForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setForm((f) => ({ ...f, credentials: "" }));
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(es.git.confirmDelete)) return;
    setBusyId(id);
    setError("");
    try {
      await api(`/api/git-integrations/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.git.title}</h1>
        <button className="btn btn-primary" onClick={toggleForm}>
          {es.git.newIntegration}
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {showForm && (
        <div className="card mb-4">
          <div className="card-body">
            <form onSubmit={handleCreate} autoComplete="off">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="git-provider">{es.git.provider}</label>
                  <select
                    id="git-provider"
                    className="form-select"
                    value={form.provider}
                    onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))}
                  >
                    {providers.map((p) => (
                      <option key={p} value={p}>
                        {es.git.providers[p]}
                      </option>
                    ))}
                  </select>
                </div>
                {form.provider === "gitea" && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="git-base-url">{es.git.baseUrl}</label>
                    <input
                      id="git-base-url"
                      className="form-input text-mono"
                      value={form.baseUrl}
                      onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                      required
                    />
                    <div className="form-hint">{es.git.baseUrlHint}</div>
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="git-credentials">{es.git.credentials}</label>
                <input
                  id="git-credentials"
                  className="form-input text-mono"
                  type="password"
                  autoComplete="new-password"
                  value={form.credentials}
                  onChange={(e) => setForm((f) => ({ ...f, credentials: e.target.value }))}
                  required
                />
                <div className="form-hint">{es.git.credentialsHint}</div>
              </div>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? es.git.creating : es.git.create}
              </button>
            </form>
          </div>
        </div>
      )}

      {integrations.length === 0 ? (
        <div className="empty-state">{es.git.empty}</div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.git.provider}</th>
                  <th>{es.git.baseUrl}</th>
                  <th>{es.git.credentials}</th>
                  <th>{es.git.sites}</th>
                  <th>{es.git.actions}</th>
                </tr>
              </thead>
              <tbody>
                {integrations.map((i) => (
                  <tr key={i.id}>
                    <td>{es.git.providers[i.provider] ?? i.provider}</td>
                    <td className="text-mono text-sm">{i.baseUrl ?? "github.com"}</td>
                    <td className="text-mono text-sm">
                      {es.git.tokenStored.replace("{last4}", i.credentialsLast4)}
                    </td>
                    <td>{i.sitesCount}</td>
                    <td>
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busyId === i.id}
                        onClick={() => handleDelete(i.id)}
                      >
                        {es.git.delete}
                      </button>
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
