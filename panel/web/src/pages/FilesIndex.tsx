import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api/client";
import { es } from "../i18n/es";

interface AccountOption {
  id: number;
  slug: string;
}

/** Entry point of the "Archivos" section: one account goes straight to its files. */
export function FilesIndex() {
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<AccountOption[]>("/api/me/accounts")
      .then(setAccounts)
      .catch((e) => {
        setError(e.message);
        setAccounts([]);
      });
  }, []);

  if (accounts === null) return <div className="loading">{es.common.loading}</div>;
  if (accounts.length === 1) {
    return <Navigate to={`/accounts/${accounts[0].id}/files`} replace />;
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.files.title}</h1>
      </div>
      {error && <div className="error-message">{error}</div>}
      {accounts.length === 0 ? (
        <div className="empty-state">
          <p>{es.client.noAccounts}</p>
        </div>
      ) : (
        <div className="card">
          <div className="card-body">
            <p className="text-secondary">{es.files.chooseAccount}</p>
            <ul className="plain-list">
              {accounts.map((a) => (
                <li key={a.id}>
                  <Link to={`/accounts/${a.id}/files`} className="text-mono">
                    {a.slug}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
