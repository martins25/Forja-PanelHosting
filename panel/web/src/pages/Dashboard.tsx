import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { api } from "../api/client";
import { es } from "../i18n/es";
import { SitesTable, type Site } from "../components/SitesTable";
import { PlanUsageWidget } from "../components/PlanUsage";

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [sites, setSites] = useState<Site[]>([]);
  const [accounts, setAccounts] = useState<{ id: number; slug: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user && !user.hasTOTP) {
      navigate("/totp-setup", { replace: true });
      return;
    }
    api<Site[]>("/api/sites")
      .then(setSites)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    api<{ id: number; slug: string }[]>("/api/me/accounts")
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [user, navigate]);

  if (!user) return null;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.dashboard.title}</h1>
        <Link to="/sites/new" className="btn btn-primary">
          {es.dashboard.createSite}
        </Link>
      </div>

      {error && <div className="error-message">{error}</div>}

      <PlanUsageWidget accounts={accounts} />

      {loading ? (
        <div className="loading">{es.common.loading}</div>
      ) : sites.length === 0 ? (
        <div className="empty-state">
          <p>{es.dashboard.noSites}</p>
          <Link to="/sites/new" className="btn btn-primary">
            {es.dashboard.createSite}
          </Link>
        </div>
      ) : (
        <SitesTable sites={sites} />
      )}
    </div>
  );
}
