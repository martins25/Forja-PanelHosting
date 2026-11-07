import { Link } from "react-router-dom";
import { es } from "../i18n/es";
import { ModeBadge, DeployBadge } from "./Badges";

export interface Deployment {
  id: number;
  status: string;
  finishedAt: string | null;
  commitSha: string;
}

export interface Site {
  id: number;
  accountId: number;
  primaryDomain: string;
  runtime: string;
  runtimeVersion: string | null;
  mode: string;
  lastDeploy: Deployment | null;
}

export function SitesTable({ sites }: { sites: Site[] }) {
  return (
    <div className="card">
      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>{es.dashboard.domain}</th>
              <th>{es.dashboard.runtime}</th>
              <th>{es.dashboard.mode}</th>
              <th>{es.dashboard.lastDeploy}</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id}>
                <td>
                  <Link to={`/sites/${site.id}`}>{site.primaryDomain}</Link>
                </td>
                <td className="text-mono">
                  {site.runtime}
                  {site.runtimeVersion ? ` ${site.runtimeVersion}` : ""}
                </td>
                <td>
                  <ModeBadge mode={site.mode} />
                </td>
                <td>
                  {site.lastDeploy ? (
                    <span className="flex items-center gap-2">
                      <DeployBadge status={site.lastDeploy.status} />
                      <span className="text-secondary text-sm">
                        {new Date(
                          site.lastDeploy.finishedAt ?? "",
                        ).toLocaleString()}
                      </span>
                    </span>
                  ) : (
                    <span className="text-secondary">
                      {es.dashboard.noDeploys}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
