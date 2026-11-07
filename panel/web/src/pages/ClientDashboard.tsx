import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/useAuth";
import { api } from "../api/client";
import { es } from "../i18n/es";
import { SitesTable, type Site } from "../components/SitesTable";
import { PlanUsageWidget } from "../components/PlanUsage";

interface AccountOption {
  id: number;
  slug: string;
  status: string;
}

export function ClientDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user && !user.hasTOTP) {
      navigate("/totp-setup", { replace: true });
      return;
    }
    Promise.all([
      api<AccountOption[]>("/api/me/accounts"),
      api<Site[]>("/api/sites"),
    ])
      .then(([accs, s]) => {
        setAccounts(accs);
        setSites(s);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [user, navigate]);

  if (!user) return null;
  if (loading) return <div className="loading">{es.common.loading}</div>;

  const selected = Number(params.get("account")) || null;
  const filter = accounts.some((a) => a.id === selected) ? selected : null;
  const visible = filter ? sites.filter((s) => s.accountId === filter) : sites;
  const multiple = accounts.length > 1;

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.dashboard.title}</h1>
        {accounts.length > 0 && (
          <Link to="/sites/new" className="btn btn-primary">
            {es.dashboard.createSite}
          </Link>
        )}
      </div>

      {error && <div className="error-message">{error}</div>}

      {accounts.length === 0 && !error ? (
        <div className="empty-state">
          <p>{es.client.noAccounts}</p>
        </div>
      ) : (
        <>
          <PlanUsageWidget
            accounts={filter ? accounts.filter((a) => a.id === filter) : accounts}
          />
          {multiple && (
            <div className="account-list" role="group" aria-label={es.client.accountsTitle}>
              <button
                className={`account-card${filter === null ? " active" : ""}`}
                onClick={() => setParams({})}
              >
                <span className="account-card-name">{es.client.allAccounts}</span>
                <span className="text-secondary text-sm">
                  {es.client.siteCount.replace("{count}", String(sites.length))}
                </span>
              </button>
              {accounts.map((a) => (
                <button
                  key={a.id}
                  className={`account-card${filter === a.id ? " active" : ""}`}
                  onClick={() => setParams({ account: String(a.id) })}
                >
                  <span className="account-card-name text-mono">{a.slug}</span>
                  <span className="text-secondary text-sm">
                    {es.client.siteCount.replace(
                      "{count}",
                      String(sites.filter((s) => s.accountId === a.id).length),
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {visible.length === 0 ? (
            <div className="empty-state">
              <p>{es.dashboard.noSites}</p>
              <Link to="/sites/new" className="btn btn-primary">
                {es.dashboard.createSite}
              </Link>
            </div>
          ) : (
            <SitesTable sites={visible} />
          )}
        </>
      )}
    </div>
  );
}
