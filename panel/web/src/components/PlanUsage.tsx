import { es } from "../i18n/es";
import { usePlanUsage, usageLevel, type PlanUsageData } from "./usePlanUsage";

type Resource = "sites" | "databases";

const t = es.planUsage;

/** Warning shown when the account is close to (or at) the plan limit of a resource. */
export function PlanLimitNotice({
  usage,
  resource,
}: {
  usage: PlanUsageData | null;
  resource: Resource;
}) {
  if (!usage) return null;
  const { current, max } = usage[resource];
  const level = usageLevel(current, max);
  if (level === "ok") return null;
  const text = (level === "full" ? t.atLimit : t.nearLimit)
    .replace("{resource}", resource === "sites" ? t.resourceSites : t.resourceDatabases)
    .replace("{current}", String(current))
    .replace("{max}", String(max));
  return (
    <div className={`plan-notice plan-notice-${level}`} role="alert">
      {text}
    </div>
  );
}

function Meter({ label, current, max }: { label: string; current: number; max: number }) {
  const level = usageLevel(current, max);
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
  return (
    <div className="plan-meter">
      <div className="plan-meter-head">
        <span>{label}</span>
        <span className="text-mono">
          {current} / {max}
        </span>
      </div>
      <div
        className="plan-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={current}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div className={`plan-meter-bar plan-meter-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AccountUsage({ accountId, slug }: { accountId: number; slug?: string }) {
  const usage = usePlanUsage(accountId);
  if (!usage) return null;
  return (
    <div className="card plan-usage">
      <div className="card-body">
        <h2 className="plan-usage-title">{slug ? t.account.replace("{slug}", slug) : t.title}</h2>
        <Meter label={t.sites} current={usage.sites.current} max={usage.sites.max} />
        <Meter label={t.databases} current={usage.databases.current} max={usage.databases.max} />
        <p className="text-secondary text-sm">
          {t.cpu}: {t.cpuValue.replace("{value}", String(usage.cpu))} · {t.memory}:{" "}
          {t.memoryValue.replace("{value}", String(usage.memory))}
        </p>
      </div>
    </div>
  );
}

/** Dashboard widget: plan usage of every given account. */
export function PlanUsageWidget({ accounts }: { accounts: { id: number; slug: string }[] }) {
  if (accounts.length === 0) return null;
  const showSlug = accounts.length > 1;
  return (
    <section className="plan-usage-list" aria-label={t.title}>
      {accounts.map((a) => (
        <AccountUsage key={a.id} accountId={a.id} slug={showSlug ? a.slug : undefined} />
      ))}
    </section>
  );
}
