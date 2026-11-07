import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { es } from "../i18n/es";

interface Remote {
  id: number;
  name: string;
  kind: "s3" | "r2";
  endpoint: string;
  bucket: string;
  region: string;
  enabled: boolean;
  accessKeyLast4: string;
  secretKeyLast4: string;
}

const t = es.backupRemotes;

const emptyForm = {
  name: "",
  kind: "r2",
  endpoint: "",
  bucket: "",
  region: "auto",
  access_key: "",
  secret_key: "",
};

export function BackupRemotes() {
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);

  const load = useCallback(() => {
    return api<Remote[]>("/api/backup-remotes")
      .then(setRemotes)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleForm() {
    if (showForm) setForm(emptyForm);
    setShowForm((v) => !v);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setMessage("");
    try {
      await api("/api/backup-remotes", { method: "POST", body: JSON.stringify(form) });
      // The keys are never kept in the UI after being sent.
      setForm(emptyForm);
      setShowForm(false);
      await load();
    } catch (err) {
      setForm((f) => ({ ...f, access_key: "", secret_key: "" }));
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(r: Remote) {
    setTestingId(r.id);
    setError("");
    setMessage("");
    try {
      await api(`/api/backup-remotes/${r.id}/test`, { method: "POST", body: "{}" });
      setMessage(t.testOk.replace("{name}", r.name));
    } catch {
      setError(t.testError.replace("{name}", r.name));
    } finally {
      setTestingId(null);
    }
  }

  async function handleToggle(r: Remote) {
    setBusyId(r.id);
    setError("");
    try {
      await api(`/api/backup-remotes/${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(r: Remote) {
    if (!confirm(t.confirmDelete)) return;
    setBusyId(r.id);
    setError("");
    try {
      await api(`/api/backup-remotes/${r.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : es.common.error);
    } finally {
      setBusyId(null);
    }
  }

  const field = (key: keyof typeof emptyForm) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{t.title}</h1>
        <button className="btn btn-primary" onClick={toggleForm}>
          {t.newRemote}
        </button>
      </div>

      <p className="form-hint">{t.intro}</p>
      <div className="alert alert-info">{t.keyWarning}</div>

      {error && <div className="error-message">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      {showForm && (
        <div className="card mb-4">
          <div className="card-body">
            <form onSubmit={handleCreate} autoComplete="off">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="br-name">{t.name}</label>
                  <input id="br-name" className="form-input" required maxLength={100} {...field("name")} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="br-kind">{t.kind}</label>
                  <select id="br-kind" className="form-select" {...field("kind")}>
                    <option value="r2">{t.kinds.r2}</option>
                    <option value="s3">{t.kinds.s3}</option>
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="br-endpoint">{t.endpoint}</label>
                <input id="br-endpoint" className="form-input text-mono" required {...field("endpoint")} />
                <div className="form-hint">{t.endpointHint}</div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="br-bucket">{t.bucket}</label>
                  <input id="br-bucket" className="form-input text-mono" required {...field("bucket")} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="br-region">{t.region}</label>
                  <input id="br-region" className="form-input text-mono" required {...field("region")} />
                  <div className="form-hint">{t.regionHint}</div>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="br-access">{t.accessKey}</label>
                  <input
                    id="br-access"
                    className="form-input text-mono"
                    type="password"
                    autoComplete="new-password"
                    required
                    {...field("access_key")}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="br-secret">{t.secretKey}</label>
                  <input
                    id="br-secret"
                    className="form-input text-mono"
                    type="password"
                    autoComplete="new-password"
                    required
                    {...field("secret_key")}
                  />
                  <div className="form-hint">{t.secretHint}</div>
                </div>
              </div>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? t.creating : t.create}
              </button>
            </form>
          </div>
        </div>
      )}

      {remotes.length === 0 ? (
        <div className="empty-state">{t.empty}</div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t.name}</th>
                  <th>{t.kind}</th>
                  <th>{t.endpoint}</th>
                  <th>{t.bucket}</th>
                  <th>{t.credentials}</th>
                  <th>{t.status}</th>
                  <th>{t.actions}</th>
                </tr>
              </thead>
              <tbody>
                {remotes.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{t.kinds[r.kind] ?? r.kind}</td>
                    <td className="text-mono text-sm">{r.endpoint}</td>
                    <td className="text-mono text-sm">{r.bucket}</td>
                    <td className="text-mono text-sm">
                      {t.stored.replace("{access}", r.accessKeyLast4).replace("{secret}", r.secretKeyLast4)}
                    </td>
                    <td>{r.enabled ? t.enabled : t.disabled}</td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={testingId === r.id}
                        onClick={() => handleTest(r)}
                      >
                        {testingId === r.id ? t.testing : t.test}
                      </button>{" "}
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => handleToggle(r)}
                      >
                        {r.enabled ? t.disable : t.enable}
                      </button>{" "}
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busyId === r.id}
                        onClick={() => handleDelete(r)}
                      >
                        {t.delete}
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
