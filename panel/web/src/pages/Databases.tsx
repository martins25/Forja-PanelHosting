import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { es } from "../i18n/es";
import { PlanLimitNotice } from "../components/PlanUsage";
import { usePlanUsage } from "../components/usePlanUsage";

interface DatabaseRow {
  id: number;
  accountId: number;
  engine: string;
  name: string;
  dbUser: string;
  passwordLast4: string;
  webTool: string;
}

interface AccountOption {
  id: number;
  slug: string;
}

interface CreateResult extends DatabaseRow {
  password: string;
}

interface ToolStartResult {
  port: number;
  containerName: string;
}

interface PasswordResult {
  password: string;
  passwordLast4: string;
}

const t = es.databases;

export function Databases() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [databases, setDatabases] = useState<DatabaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<number, string>>({});
  const [toolPorts, setToolPorts] = useState<Record<number, number>>({});

  const [form, setForm] = useState({
    accountId: "",
    engine: "",
    name: "",
    db_user: "",
  });

  const usage = usePlanUsage(form.accountId || null);

  const load = useCallback(() => {
    return api<AccountOption[]>("/api/me/accounts")
      .then(async (accs) => {
        setAccounts(accs);
        const allDBs: DatabaseRow[] = [];
        for (const acc of accs) {
          const dbs = await api<DatabaseRow[]>(
            `/api/accounts/${acc.id}/databases`,
          );
          allDBs.push(...dbs);
        }
        setDatabases(allDBs);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function accountSlug(accountId: number): string {
    return accounts.find((a) => a.id === accountId)?.slug ?? String(accountId);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const result = await api<CreateResult>(
        `/api/accounts/${form.accountId}/databases`,
        {
          method: "POST",
          body: JSON.stringify({
            engine: form.engine,
            name: form.name,
            db_user: form.db_user,
          }),
        },
      );
      setRevealedPasswords((prev) => ({ ...prev, [result.id]: result.password }));
      setShowForm(false);
      setForm({ accountId: "", engine: "", name: "", db_user: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorCreating);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(db: DatabaseRow) {
    if (!confirm(t.confirmDelete)) return;
    setError("");
    setBusyId(db.id);
    try {
      await api(`/api/accounts/${db.accountId}/databases/${db.id}`, {
        method: "DELETE",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.errorDeleting);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDump(db: DatabaseRow) {
    setError("");
    setMessage("");
    setBusyId(db.id);
    try {
      const result = await api<{ path: string }>(
        `/api/accounts/${db.accountId}/databases/${db.id}/dump`,
        { method: "POST" },
      );
      setMessage(`${t.dumpSuccess}: ${result.path}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleChangePassword(db: DatabaseRow) {
    setError("");
    setMessage("");
    setBusyId(db.id);
    try {
      const result = await api<PasswordResult>(
        `/api/accounts/${db.accountId}/databases/${db.id}/password`,
        { method: "PATCH" },
      );
      setRevealedPasswords((prev) => ({ ...prev, [db.id]: result.password }));
      setMessage(t.passwordChanged);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleStartTool(db: DatabaseRow, tool: string) {
    setError("");
    setMessage("");
    setBusyId(db.id);
    try {
      const result = await api<ToolStartResult>(
        `/api/accounts/${db.accountId}/databases/${db.id}/tool/start`,
        { method: "POST", body: JSON.stringify({ tool }) },
      );
      setToolPorts((prev) => ({ ...prev, [db.id]: result.port }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusyId(null);
    }
  }

  async function handleStopTool(db: DatabaseRow) {
    setError("");
    setBusyId(db.id);
    try {
      await api(
        `/api/accounts/${db.accountId}/databases/${db.id}/tool/stop`,
        { method: "POST" },
      );
      setToolPorts((prev) => {
        const copy = { ...prev };
        delete copy[db.id];
        return copy;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusyId(null);
    }
  }

  function defaultTool(engine: string): string {
    if (engine === "postgres") return "pgadmin";
    return "phpmyadmin";
  }

  if (loading) return <p>{es.common.loading}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t.title}</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(true)}>
          {t.create}
        </button>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}

      {showForm && (
        <form className="card form-card" onSubmit={handleCreate}>
          <PlanLimitNotice usage={usage} resource="databases" />
          <div className="form-group">
            <label>{t.account}</label>
            <select
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              required
            >
              <option value="">{t.selectAccount}</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.slug}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>{t.engine}</label>
            <select
              value={form.engine}
              onChange={(e) => setForm({ ...form, engine: e.target.value })}
              required
            >
              <option value="">{t.selectEngine}</option>
              <option value="mariadb">{t.engines.mariadb}</option>
              <option value="mysql">{t.engines.mysql}</option>
              <option value="postgres">{t.engines.postgres}</option>
            </select>
          </div>
          <div className="form-group">
            <label>{t.name}</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              pattern="^[a-z][a-z0-9_]{2,40}$"
              required
            />
          </div>
          <div className="form-group">
            <label>{t.dbUser}</label>
            <input
              type="text"
              value={form.db_user}
              onChange={(e) => setForm({ ...form, db_user: e.target.value })}
              pattern="^[a-z][a-z0-9_]{2,40}$"
              required
            />
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? t.creating : t.create}
            </button>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => setShowForm(false)}
            >
              {es.common.cancel}
            </button>
          </div>
        </form>
      )}

      {databases.length === 0 && !showForm ? (
        <p className="empty-state">{t.empty}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t.account}</th>
              <th>{t.name}</th>
              <th>{t.engine}</th>
              <th>{t.dbUser}</th>
              <th>{t.password}</th>
              <th>{t.webTool}</th>
              <th>{t.actions}</th>
            </tr>
          </thead>
          <tbody>
            {databases.map((db) => (
              <tr key={db.id}>
                <td>{accountSlug(db.accountId)}</td>
                <td>{db.name}</td>
                <td>{t.engines[db.engine] ?? db.engine}</td>
                <td>{db.dbUser}</td>
                <td>
                  {revealedPasswords[db.id] ? (
                    <code>{revealedPasswords[db.id]}</code>
                  ) : (
                    <span>****{db.passwordLast4}</span>
                  )}
                </td>
                <td>{t.tools[db.webTool] ?? db.webTool}</td>
                <td>
                  <div className="btn-group">
                    <button
                      className="btn btn-sm"
                      disabled={busyId === db.id}
                      onClick={() => handleDump(db)}
                    >
                      {busyId === db.id ? t.dumping : t.dump}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busyId === db.id}
                      onClick={() => handleChangePassword(db)}
                    >
                      {busyId === db.id ? t.changingPassword : t.changePassword}
                    </button>
                    {db.webTool === "none" ? (
                      <button
                        className="btn btn-sm"
                        disabled={busyId === db.id}
                        onClick={() => handleStartTool(db, defaultTool(db.engine))}
                      >
                        {busyId === db.id ? t.startingTool : t.startTool}
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm"
                        disabled={busyId === db.id}
                        onClick={() => handleStopTool(db)}
                      >
                        {busyId === db.id ? t.stoppingTool : t.stopTool}
                      </button>
                    )}
                    {toolPorts[db.id] && (
                      <span className="badge badge-success">
                        Puerto: {toolPorts[db.id]}
                      </span>
                    )}
                    <button
                      className="btn btn-sm btn-danger"
                      disabled={busyId === db.id}
                      onClick={() => handleDelete(db)}
                    >
                      {t.delete}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
