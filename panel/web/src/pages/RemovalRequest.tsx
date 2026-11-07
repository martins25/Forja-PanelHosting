import { useEffect, useState, useCallback, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { es } from "../i18n/es";
import { RemovalStatusBadge } from "../components/Badges";

export interface RemovalRequestItem {
  id: number;
  siteId: number;
  accountId: number;
  accountSlug: string;
  domain: string;
  requestedBy: number;
  requestedByEmail: string;
  reason: string | null;
  status: "open" | "done" | "rejected";
  createdAt: string;
  reviewedAt: string | null;
}

export function RemovalRequest() {
  const { id } = useParams<{ id: string }>();
  const siteId = Number(id);
  const [domain, setDomain] = useState("");
  const [requests, setRequests] = useState<RemovalRequestItem[]>([]);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      const [site, all] = await Promise.all([
        api<{ primaryDomain: string }>(`/api/sites/${siteId}`),
        api<RemovalRequestItem[]>("/api/removal-requests"),
      ]);
      setDomain(site.primaryDomain);
      setRequests(all.filter((r) => r.siteId === siteId));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : es.removal.errorLoad);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const hasOpen = requests.some((r) => r.status === "open");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setSent(false);
    try {
      await api(`/api/sites/${siteId}/removal-request`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      setReason("");
      setSent(true);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "REQUEST_ALREADY_OPEN"
          ? es.removal.alreadyOpen
          : es.removal.errorGeneric,
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  return (
    <div>
      <div className="mb-4">
        <Link to={`/sites/${siteId}`} className="text-secondary text-sm">
          {es.removal.backToSite}
        </Link>
      </div>
      <div className="page-header">
        <h1 className="page-title">
          {es.removal.title.replace("{domain}", domain)}
        </h1>
      </div>

      {error && <div className="error-message">{error}</div>}
      {sent && <p role="status" className="text-secondary">{es.removal.sent}</p>}

      {hasOpen ? (
        <p className="text-secondary">{es.removal.alreadyOpen}</p>
      ) : (
        <form className="card card-body" onSubmit={handleSubmit}>
          <p className="text-secondary">{es.removal.intro}</p>
          <div className="form-group">
            <label className="form-label" htmlFor="removal-reason">
              {es.removal.reason}
            </label>
            <textarea
              id="removal-reason"
              className="form-input"
              rows={4}
              maxLength={1000}
              placeholder={es.removal.reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div>
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? es.removal.submitting : es.removal.submit}
            </button>
          </div>
        </form>
      )}

      <h2 className="mt-4">{es.removal.history}</h2>
      {requests.length === 0 ? (
        <div className="empty-state">
          <p>{es.removal.noHistory}</p>
        </div>
      ) : (
        <div className="card">
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{es.removal.date}</th>
                  <th>{es.removal.reason}</th>
                  <th>{es.removal.statusLabel}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td>{r.reason ?? "—"}</td>
                    <td>
                      <RemovalStatusBadge status={r.status} />
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
