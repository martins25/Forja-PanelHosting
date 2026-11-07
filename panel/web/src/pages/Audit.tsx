import { useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { es } from "../i18n/es";

interface AuditEntry {
  id: number;
  at: string;
  actorUserId: number | null;
  actorKind: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: string;
  errorCode: string | null;
}

interface AuditResponse {
  data: AuditEntry[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterAction, setFilterAction] = useState("");

  const fetchAudit = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    if (filterAction) params.set("action", filterAction);

    api<AuditResponse>(`/api/audit?${params}`)
      .then((data) => {
        setEntries(data.data);
        setTotalPages(data.totalPages);
        setTotal(data.total);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [page, filterAction]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  function actorLabel(entry: AuditEntry) {
    if (entry.actorKind === "system") return es.audit.system;
    if (entry.actorKind === "webhook") return es.audit.webhook;
    return entry.actorEmail ?? `#${entry.actorUserId}`;
  }

  function resultBadge(result: string) {
    return result === "ok" ? (
      <span className="badge badge-success">{es.common.ok}</span>
    ) : (
      <span className="badge badge-danger">{es.common.errorResult}</span>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.audit.title}</h1>
      </div>

      <div className="filter-bar">
        <select
          className="form-select"
          value={filterAction}
          onChange={(e) => {
            setFilterAction(e.target.value);
            setPage(1);
          }}
        >
          <option value="">{es.audit.allActions}</option>
          <option value="site.create">site.create</option>
          <option value="site.deploy">site.deploy</option>
          <option value="site.set_mode">site.set_mode</option>
          <option value="env_var.create">env_var.create</option>
          <option value="env_var.update">env_var.update</option>
          <option value="env_var.delete">env_var.delete</option>
          <option value="account.create">account.create</option>
          <option value="cf_connection.create">cf_connection.create</option>
          <option value="cf_connection.apply">cf_connection.apply</option>
          <option value="cf_connection.sync_routes">cf_connection.sync_routes</option>
          <option value="cf_connection.delete">cf_connection.delete</option>
          <option value="auth.login">auth.login</option>
        </select>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">{es.common.loading}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p>{es.audit.noEntries}</p>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>{es.audit.date}</th>
                    <th>{es.audit.actor}</th>
                    <th>{es.audit.action}</th>
                    <th>{es.audit.targetType}</th>
                    <th>{es.audit.targetId}</th>
                    <th>{es.audit.result}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id}>
                      <td className="text-sm">
                        {new Date(entry.at).toLocaleString()}
                      </td>
                      <td>{actorLabel(entry)}</td>
                      <td className="text-mono">{entry.action}</td>
                      <td>{entry.targetType ?? "—"}</td>
                      <td className="text-mono">{entry.targetId ?? "—"}</td>
                      <td>{resultBadge(entry.result)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                className="btn btn-secondary btn-sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {es.audit.prev}
              </button>
              <span className="pagination-info">
                {es.audit.pageOf
                  .replace("{page}", String(page))
                  .replace("{total}", String(totalPages))}
                {" "}({total})
              </span>
              <button
                className="btn btn-secondary btn-sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                {es.audit.next}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
