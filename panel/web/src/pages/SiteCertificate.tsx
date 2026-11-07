import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { es } from "../i18n/es";

export interface CertificateData {
  id: number;
  siteId: number;
  domain: string;
  provider: "letsencrypt";
  status: "pending" | "active" | "expired" | "error";
  issuedAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
}

const POLL_MS = 10_000;

function CertificateStatusBadge({ status }: { status: CertificateData["status"] }) {
  const map = {
    pending: ["badge-warning", es.certificate.statusPending],
    active: ["badge-success", es.certificate.statusActive],
    expired: ["badge-danger", es.certificate.statusExpired],
    error: ["badge-danger", es.certificate.statusError],
  } as const;
  const [cls, label] = map[status];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es-ES");
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof ApiError && e.code === "NO_CF_CONNECTION") {
    return es.certificate.noCloudflare;
  }
  return fallback;
}

export default function SiteCertificate({ siteId }: { siteId: number }) {
  const [cert, setCert] = useState<CertificateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setCert(await api<CertificateData>(`/api/sites/${siteId}/certificate`));
      setError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setCert(null);
        setError("");
      } else {
        setError(es.certificate.errorLoad);
      }
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  // Issuance is asynchronous: keep checking while it is pending.
  useEffect(() => {
    if (cert?.status !== "pending") return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [cert?.status, load]);

  async function run(path: string, fallback: string) {
    setBusy(true);
    setError("");
    try {
      setCert(await api<CertificateData>(`/api/sites/${siteId}/certificate${path}`, { method: "POST" }));
    } catch (e) {
      // Reload first: a successful load clears the error banner.
      await load();
      setError(errorMessage(e, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="loading">{es.common.loading}</div>;

  const canRequest = !cert || cert.status === "error" || cert.status === "expired";

  return (
    <div>
      {error && <div className="error-message">{error}</div>}

      <div className="card mb-4">
        <div className="card-body">
          <h2 className="mb-2">{es.certificate.title}</h2>
          <p className="text-secondary text-sm mb-4">{es.certificate.intro}</p>

          {cert ? (
            <div className="detail-grid">
              <span className="detail-label">{es.certificate.statusLabel}</span>
              <span>
                <CertificateStatusBadge status={cert.status} />
              </span>
              <span className="detail-label">{es.certificate.domain}</span>
              <span className="text-mono">{cert.domain}</span>
              <span className="detail-label">{es.certificate.provider}</span>
              <span>{es.certificate.providerLetsencrypt}</span>
              <span className="detail-label">{es.certificate.issuedAt}</span>
              <span>{formatDate(cert.issuedAt)}</span>
              <span className="detail-label">{es.certificate.expiresAt}</span>
              <span>{formatDate(cert.expiresAt)}</span>
              <span className="detail-label">{es.certificate.autoRenew}</span>
              <span>{cert.autoRenew ? es.certificate.yes : es.certificate.no}</span>
            </div>
          ) : (
            <p>
              {es.certificate.none} <span className="text-secondary">({es.certificate.protectedByCloudflare})</span>
            </p>
          )}

          {cert?.status === "pending" && (
            <p className="text-secondary text-sm mt-2">{es.certificate.pendingHint}</p>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        {canRequest && (
          <button className="btn btn-primary" onClick={() => run("", es.certificate.errorRequest)} disabled={busy}>
            {busy ? es.certificate.requesting : es.certificate.request}
          </button>
        )}
        {cert && cert.status !== "error" && (
          <button className="btn btn-secondary" onClick={() => run("/renew", es.certificate.errorRenew)} disabled={busy}>
            {busy ? es.certificate.renewing : es.certificate.renew}
          </button>
        )}
      </div>
    </div>
  );
}
