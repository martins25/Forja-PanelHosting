import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";
import { AlertStatusBadge } from "../components/Badges";

type AlertEvent = keyof typeof es.alerts.events;

const EVENTS: AlertEvent[] = [
  "site_down",
  "deploy_failed",
  "disk_high",
  "ram_high",
  "backup_failed",
];
const THRESHOLD_EVENTS: AlertEvent[] = ["disk_high", "ram_high"];

interface Channel {
  id: number;
  userId: number;
  kind: "email";
  address: string;
  enabled: boolean;
}

interface Rule {
  id: number;
  userId: number;
  event: AlertEvent;
  channelId: number;
  threshold: { percent: number } | null;
}

interface LogEntry {
  id: number;
  channelId: number;
  ownerEmail: string;
  event: AlertEvent;
  message: string;
  sentAt: string;
  status: string;
}

function errorMessage(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

export function Alerts() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [channels, setChannels] = useState<Channel[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [showChannelForm, setShowChannelForm] = useState(false);
  const [address, setAddress] = useState("");
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState({
    event: "site_down" as AlertEvent,
    channelId: "",
    percent: "",
  });

  const load = useCallback(() => {
    return Promise.all([
      api<Channel[]>("/api/alerts/channels"),
      api<Rule[]>("/api/alerts/rules"),
      api<LogEntry[]>("/api/alerts/log"),
    ])
      .then(([c, r, l]) => {
        setChannels(c);
        setRules(r);
        setLog(l);
        setError("");
      })
      .catch((e) => setError(errorMessage(e, es.alerts.errorLoad)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Rules can only use the caller's own channels, even for an admin who sees everyone's.
  const ownChannels = channels.filter((c) => c.userId === user?.id);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateChannel(e: FormEvent) {
    e.preventDefault();
    const ok = await run(
      () =>
        api("/api/alerts/channels", {
          method: "POST",
          body: JSON.stringify({ kind: "email", address }),
        }),
      es.alerts.errorSave,
    );
    if (ok) {
      setAddress("");
      setShowChannelForm(false);
    }
  }

  function toggleChannel(c: Channel) {
    return run(
      () =>
        api(`/api/alerts/channels/${c.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !c.enabled }),
        }),
      es.alerts.errorSave,
    );
  }

  function deleteChannel(c: Channel) {
    if (!window.confirm(es.alerts.confirmDeleteChannel)) return;
    return run(
      () => api(`/api/alerts/channels/${c.id}`, { method: "DELETE" }),
      es.alerts.errorDelete,
    );
  }

  async function handleCreateRule(e: FormEvent) {
    e.preventDefault();
    const channelId = Number(ruleForm.channelId || ownChannels[0]?.id);
    const payload: Record<string, unknown> = {
      event: ruleForm.event,
      channelId,
    };
    if (THRESHOLD_EVENTS.includes(ruleForm.event) && ruleForm.percent !== "") {
      payload.threshold = { percent: Number(ruleForm.percent) };
    }
    const ok = await run(
      () =>
        api("/api/alerts/rules", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      es.alerts.errorSave,
    );
    if (ok) {
      setRuleForm({ event: "site_down", channelId: "", percent: "" });
      setShowRuleForm(false);
    }
  }

  function deleteRule(r: Rule) {
    if (!window.confirm(es.alerts.confirmDeleteRule)) return;
    return run(
      () => api(`/api/alerts/rules/${r.id}`, { method: "DELETE" }),
      es.alerts.errorDelete,
    );
  }

  function channelAddress(id: number) {
    return channels.find((c) => c.id === id)?.address ?? `#${id}`;
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.alerts.title}</h1>
      </div>
      <p className="text-sm mb-4">{es.alerts.intro}</p>

      {error && <div className="error-message">{error}</div>}

      <section className="mb-4">
        <div className="page-header">
          <h2 className="section-title">{es.alerts.channelsTitle}</h2>
          <button
            className="btn btn-primary"
            onClick={() => setShowChannelForm((v) => !v)}
          >
            {es.alerts.newChannel}
          </button>
        </div>

        {showChannelForm && (
          <div className="card mb-4">
            <div className="card-body">
              <form onSubmit={handleCreateChannel}>
                <div className="form-group">
                  <label className="form-label" htmlFor="alert-address">
                    {es.alerts.address}
                  </label>
                  <input
                    id="alert-address"
                    className="form-input"
                    type="email"
                    maxLength={254}
                    placeholder={es.alerts.addressPlaceholder}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    required
                  />
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  {es.common.save}
                </button>{" "}
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setShowChannelForm(false)}
                >
                  {es.common.cancel}
                </button>
              </form>
            </div>
          </div>
        )}

        {channels.length === 0 ? (
          <div className="empty-state">
            <p>{es.alerts.noChannels}</p>
          </div>
        ) : (
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>{es.alerts.address}</th>
                    {isAdmin && <th>{es.alerts.owner}</th>}
                    <th>{es.alerts.status}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => (
                    <tr key={c.id}>
                      <td className="text-mono">{c.address}</td>
                      {isAdmin && <td>{c.userId === user?.id ? user.email : `#${c.userId}`}</td>}
                      <td>{c.enabled ? es.alerts.enabled : es.alerts.disabled}</td>
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={busy}
                          onClick={() => toggleChannel(c)}
                        >
                          {c.enabled ? es.alerts.pause : es.alerts.resume}
                        </button>{" "}
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => deleteChannel(c)}
                        >
                          {es.common.delete}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="mb-4">
        <div className="page-header">
          <h2 className="section-title">{es.alerts.rulesTitle}</h2>
          <button
            className="btn btn-primary"
            disabled={ownChannels.length === 0}
            onClick={() => setShowRuleForm((v) => !v)}
          >
            {es.alerts.newRule}
          </button>
        </div>
        {ownChannels.length === 0 && (
          <p className="text-sm">{es.alerts.needChannelFirst}</p>
        )}

        {showRuleForm && ownChannels.length > 0 && (
          <div className="card mb-4">
            <div className="card-body">
              <form onSubmit={handleCreateRule}>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label" htmlFor="rule-event">
                      {es.alerts.event}
                    </label>
                    <select
                      id="rule-event"
                      className="form-select"
                      value={ruleForm.event}
                      onChange={(e) =>
                        setRuleForm((f) => ({
                          ...f,
                          event: e.target.value as AlertEvent,
                          percent: "",
                        }))
                      }
                    >
                      {EVENTS.map((ev) => (
                        <option key={ev} value={ev}>
                          {es.alerts.events[ev]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="rule-channel">
                      {es.alerts.channel}
                    </label>
                    <select
                      id="rule-channel"
                      className="form-select"
                      value={ruleForm.channelId || String(ownChannels[0].id)}
                      onChange={(e) =>
                        setRuleForm((f) => ({ ...f, channelId: e.target.value }))
                      }
                    >
                      {ownChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.address}
                        </option>
                      ))}
                    </select>
                  </div>
                  {THRESHOLD_EVENTS.includes(ruleForm.event) && (
                    <div className="form-group">
                      <label className="form-label" htmlFor="rule-percent">
                        {es.alerts.thresholdLabel}
                      </label>
                      <input
                        id="rule-percent"
                        className="form-input"
                        type="number"
                        min={1}
                        max={100}
                        placeholder="90"
                        value={ruleForm.percent}
                        onChange={(e) =>
                          setRuleForm((f) => ({ ...f, percent: e.target.value }))
                        }
                      />
                      <div className="form-hint">{es.alerts.thresholdHint}</div>
                    </div>
                  )}
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  {es.common.save}
                </button>{" "}
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => setShowRuleForm(false)}
                >
                  {es.common.cancel}
                </button>
              </form>
            </div>
          </div>
        )}

        {rules.length === 0 ? (
          <div className="empty-state">
            <p>{es.alerts.noRules}</p>
          </div>
        ) : (
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>{es.alerts.event}</th>
                    <th>{es.alerts.channel}</th>
                    <th>{es.alerts.threshold}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td>{es.alerts.events[r.event]}</td>
                      <td className="text-mono">{channelAddress(r.channelId)}</td>
                      <td>
                        {r.threshold
                          ? es.alerts.thresholdPercent.replace(
                              "{value}",
                              String(r.threshold.percent),
                            )
                          : "—"}
                      </td>
                      <td>
                        <button
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => deleteRule(r)}
                        >
                          {es.common.delete}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="page-header">
          <h2 className="section-title">{es.alerts.logTitle}</h2>
        </div>
        {log.length === 0 ? (
          <div className="empty-state">
            <p>{es.alerts.noLog}</p>
          </div>
        ) : (
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>{es.alerts.date}</th>
                    <th>{es.alerts.event}</th>
                    <th>{es.alerts.message}</th>
                    <th>{es.alerts.status}</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((l) => (
                    <tr key={l.id}>
                      <td className="text-sm">{new Date(l.sentAt).toLocaleString()}</td>
                      <td>{es.alerts.events[l.event]}</td>
                      <td>{l.message}</td>
                      <td>
                        <AlertStatusBadge status={l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
