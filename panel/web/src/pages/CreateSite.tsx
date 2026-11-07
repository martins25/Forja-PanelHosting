import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { es } from "../i18n/es";
import { PlanLimitNotice } from "../components/PlanUsage";
import { usePlanUsage } from "../components/usePlanUsage";

interface Account {
  id: number;
  slug: string;
  status: string;
}

interface GitIntegration {
  id: number;
  provider: "github" | "gitea";
  baseUrl: string | null;
}

type Source = "github" | "gitea";

type Runtime = "node" | "php" | "python" | "static" | "docker";

const runtimeVersionOptions: Record<string, string[]> = {
  node: ["22", "20", "18", "24"],
  php: ["8.4", "8.3", "8.2", "8.1"],
  python: ["3.13", "3.12", "3.11"],
};

const runtimeDefaults: Record<
  Runtime,
  { installCmd: string; startCmd: string; publicDir: string; version: string }
> = {
  node: { installCmd: "npm ci", startCmd: "npm start", publicDir: "", version: "22" },
  php: { installCmd: "composer install --no-dev", startCmd: "", publicDir: "public", version: "8.4" },
  python: { installCmd: "pip install --no-cache-dir -r requirements.txt", startCmd: "gunicorn app:app -b 0.0.0.0:8000", publicDir: "", version: "3.13" },
  static: { installCmd: "", startCmd: "", publicDir: "public", version: "" },
  docker: { installCmd: "", startCmd: "", publicDir: "", version: "" },
};

export function CreateSite() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [domain, setDomain] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("node");
  const [runtimeVersion, setRuntimeVersion] = useState("22");
  const [source, setSource] = useState<Source>("github");
  const [giteaIntegrations, setGiteaIntegrations] = useState<GitIntegration[]>([]);
  const [gitIntegrationId, setGitIntegrationId] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [installCmd, setInstallCmd] = useState("npm ci");
  const [buildCmd, setBuildCmd] = useState("");
  const [startCmd, setStartCmd] = useState("npm start");
  const [publicDir, setPublicDir] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const usage = usePlanUsage(accountId);

  useEffect(() => {
    api<Account[]>("/api/me/accounts").then((data) => {
      const active = data.filter((a) => a.status === "active");
      setAccounts(active);
      if (active.length === 1) setAccountId(String(active[0].id));
    });
    api<GitIntegration[]>("/api/git-integrations")
      .then((data) => {
        const gitea = data.filter((i) => i.provider === "gitea");
        setGiteaIntegrations(gitea);
        if (gitea.length === 1) setGitIntegrationId(String(gitea[0].id));
      })
      .catch(() => setGiteaIntegrations([]));
  }, []);

  function handleSourceChange(next: Source) {
    setSource(next);
    setRepo("");
  }

  function handleRuntimeChange(r: Runtime) {
    setRuntime(r);
    const d = runtimeDefaults[r];
    setInstallCmd(d.installCmd);
    setStartCmd(d.startCmd);
    setPublicDir(d.publicDir);
    setRuntimeVersion(d.version);
    setBuildCmd("");
  }

  const showVersion = runtime === "node" || runtime === "php" || runtime === "python";
  const showInstallCmd = runtime === "node" || runtime === "php" || runtime === "python";
  const showBuildCmd = runtime === "node" || runtime === "python" || runtime === "static";
  const showStartCmd = runtime === "node" || runtime === "php" || runtime === "python";
  const showPublicDir = runtime === "php" || runtime === "static";

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const site = await api<{ id: number }>("/api/sites", {
        method: "POST",
        body: JSON.stringify({
          accountId: Number(accountId),
          primaryDomain: domain,
          runtime,
          runtimeVersion: runtimeVersion || undefined,
          source,
          repo,
          gitIntegrationId: source === "gitea" ? Number(gitIntegrationId) : undefined,
          branch,
          installCmd: installCmd || undefined,
          buildCmd: buildCmd || undefined,
          startCmd: startCmd || undefined,
          publicDir: publicDir || undefined,
        }),
      });
      navigate(`/sites/${site.id}`, { replace: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : es.sites.errorCreating,
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">{es.sites.createTitle}</h1>
        <Link to="/" className="btn btn-secondary">
          {es.sites.backToList}
        </Link>
      </div>

      {error && <div className="error-message">{error}</div>}
      <PlanLimitNotice usage={usage} resource="sites" />

      <div className="card">
        <div className="card-body">
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label" htmlFor="site-account">{es.sites.account}</label>
              <select
                id="site-account"
                className="form-select"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                required
              >
                <option value="">{es.sites.selectAccount}</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.slug}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label">{es.sites.domain}</label>
                <input
                  className="form-input"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder={es.sites.domainHint}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">{es.sites.runtime}</label>
                <select
                  className="form-select"
                  value={runtime}
                  onChange={(e) => handleRuntimeChange(e.target.value as Runtime)}
                >
                  {(["node", "php", "python", "static", "docker"] as Runtime[]).map(
                    (r) => (
                      <option key={r} value={r}>
                        {es.sites.runtimes[r]}
                      </option>
                    ),
                  )}
                </select>
              </div>
            </div>

            {showVersion && (
              <div className="form-group">
                <label className="form-label">{es.sites.runtimeVersion}</label>
                <select
                  className="form-select"
                  value={runtimeVersion}
                  onChange={(e) => setRuntimeVersion(e.target.value)}
                >
                  {(runtimeVersionOptions[runtime] ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="site-source">{es.sites.source}</label>
                <select
                  id="site-source"
                  className="form-select"
                  value={source}
                  onChange={(e) => handleSourceChange(e.target.value as Source)}
                >
                  {(["github", "gitea"] as Source[]).map((s) => (
                    <option key={s} value={s}>
                      {es.sites.sources[s]}
                    </option>
                  ))}
                </select>
              </div>
              {source === "gitea" && (
                <div className="form-group">
                  <label className="form-label" htmlFor="site-gitea-integration">{es.sites.giteaIntegration}</label>
                  <select
                    id="site-gitea-integration"
                    className="form-select"
                    value={gitIntegrationId}
                    onChange={(e) => setGitIntegrationId(e.target.value)}
                    required
                  >
                    <option value="">{es.sites.selectIntegration}</option>
                    {giteaIntegrations.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.baseUrl}
                      </option>
                    ))}
                  </select>
                  {giteaIntegrations.length === 0 && (
                    <div className="form-hint">{es.sites.noGiteaIntegrations}</div>
                  )}
                </div>
              )}
            </div>

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="site-repo">
                  {source === "gitea" ? es.sites.giteaRepo : es.sites.repo}
                </label>
                <input
                  id="site-repo"
                  className="form-input"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder={source === "gitea" ? es.sites.giteaRepoHint : es.sites.repoHint}
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">{es.sites.branch}</label>
                <input
                  className="form-input"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                />
              </div>
            </div>

            {runtime === "docker" && (
              <div className="form-group">
                <p className="text-secondary text-sm">{es.sites.dockerHint}</p>
              </div>
            )}

            {showInstallCmd && (
              <div className="form-group">
                <label className="form-label">{es.sites.installCmd}</label>
                <input
                  className="form-input"
                  value={installCmd}
                  onChange={(e) => setInstallCmd(e.target.value)}
                />
              </div>
            )}

            {showBuildCmd && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{es.sites.buildCmd}</label>
                  <input
                    className="form-input"
                    value={buildCmd}
                    onChange={(e) => setBuildCmd(e.target.value)}
                  />
                </div>
                {showStartCmd && (
                  <div className="form-group">
                    <label className="form-label">{es.sites.startCmd}</label>
                    <input
                      className="form-input"
                      value={startCmd}
                      onChange={(e) => setStartCmd(e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            {!showBuildCmd && showStartCmd && (
              <div className="form-group">
                <label className="form-label">{es.sites.startCmd}</label>
                <input
                  className="form-input"
                  value={startCmd}
                  onChange={(e) => setStartCmd(e.target.value)}
                />
              </div>
            )}

            {runtime === "static" && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">{es.sites.installCmd}</label>
                  <input
                    className="form-input"
                    value={installCmd}
                    onChange={(e) => setInstallCmd(e.target.value)}
                    placeholder="npm ci"
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{es.sites.publicDir}</label>
                  <input
                    className="form-input"
                    value={publicDir}
                    onChange={(e) => setPublicDir(e.target.value)}
                    placeholder={es.sites.publicDirHint}
                  />
                </div>
              </div>
            )}

            {showPublicDir && runtime !== "static" && (
              <div className="form-group">
                <label className="form-label">{es.sites.publicDir}</label>
                <input
                  className="form-input"
                  value={publicDir}
                  onChange={(e) => setPublicDir(e.target.value)}
                  placeholder={es.sites.publicDirHint}
                />
              </div>
            )}

            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? es.sites.creating : es.sites.create}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
