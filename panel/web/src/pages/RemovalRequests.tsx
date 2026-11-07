import { useEffect, useState, useCallback } from "react";
import { api, ApiError } from "../api/client";
import { es } from "../i18n/es";
import { RemovalStatusBadge } from "../components/Badges";
import type { RemovalRequestItem } from "./RemovalRequest";

export function RemovalRequests() {
  const [items, setItems] = useState<RemovalRequestItem[]>([]);
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const qs = onlyOpen ? "?status=open" : "";
    api<RemovalRequestItem[]>(`/api/removal-requests${qs}`)
      .then((data) => {
        setItems(data);
        setError("");
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : es.removal.errorLoad),
      )
      .finally(() => setLoading(false));
  }, [onlyOpen]);

  useEffect(() => {
    load();
  }, [load]);

  async function review(item: RemovalRequestItem, status: "done" | "rejected") {
    const msg =
      status === "done" ? es.removal.confirmApprove : es.removal.confirmReject;
    if (!window.confirm(msg.replace("{domain}", item.domain))) return;
    setBusyId(item.id);
    setError("");
    try {
      await api(`/api/removal-requests/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : es.removal.errorReview);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.removal.adminTitle}</h1>
      </div>

      <div className="filter-bar">
        <select
          className="form-select"
          aria-label={es.removal.statusLabel}
          value={onlyOpen ? "open" : "all"}
          onChange={(e) => setOnlyOpen(e.target.value === "open")}
        >
          <option value="open">{es.removal.filterOpen}</option>
          <option value="all">{es.removal.filterAll}</option>
        </select>
      </div>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading">{es.common.loading}</div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <p>{es.removal.noRequests}</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.removal.site}</th>
                  <th>{es.removal.account}</th>
                  <th>{es.removal.requestedBy}</th>
                  <th>{es.removal.reason}</th>
                  <th>{es.removal.date}</th>
                  <th>{es.removal.statusLabel}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td className="text-mono">{r.domain}</td>
                    <td>{r.accountSlug}</td>
                    <td>{r.requestedByEmail}</td>
                    <td>{r.reason ?? "—"}</td>
                    <td className="text-sm">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <RemovalStatusBadge status={r.status} />
                    </td>
                    <td>
                      {r.status === "open" && (
                        <>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={busyId === r.id}
                            onClick={() => review(r, "done")}
                          >
                            {es.removal.approve}
                          </button>{" "}
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={busyId === r.id}
                            onClick={() => review(r, "rejected")}
                          >
                            {es.removal.reject}
                          </button>
                        </>
                      )}
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
