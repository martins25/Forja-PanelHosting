import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../context/useAuth";
import { es } from "../i18n/es";

interface TopEntry {
  name: string;
  count: number;
}

interface StatsDay {
  date: string;
  pageviews: number;
  uniqueVisitors: number;
  topPaths: TopEntry[];
  topReferrers: TopEntry[];
  topCountries: TopEntry[];
}

interface StatsResponse {
  from: string;
  to: string;
  totals: { pageviews: number; uniqueVisitors: number };
  days: StatsDay[];
}

const RANGES = [
  { days: 7, label: es.stats.range7 },
  { days: 30, label: es.stats.range30 },
  { days: 90, label: es.stats.range90 },
] as const;

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Merge the per-day top lists into a single ranked list for the whole period.
function mergeTop(days: StatsDay[], key: "topPaths" | "topReferrers" | "topCountries"): TopEntry[] {
  const totals = new Map<string, number>();
  for (const d of days) {
    for (const e of d[key]) totals.set(e.name, (totals.get(e.name) ?? 0) + e.count);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
}

function BarChart({ days }: { days: { date: string; pageviews: number }[] }) {
  const max = Math.max(1, ...days.map((d) => d.pageviews));
  const width = 600;
  const height = 160;
  const gap = 2;
  const barWidth = Math.max(1, width / days.length - gap);
  return (
    <svg
      viewBox={`0 0 ${width} ${height + 16}`}
      role="img"
      aria-label={es.stats.pageviewsPerDay}
      style={{ width: "100%", height: "auto" }}
    >
      {days.map((d, i) => {
        const h = (d.pageviews / max) * height;
        const x = i * (barWidth + gap);
        return (
          <rect
            key={d.date}
            x={x}
            y={height - h}
            width={barWidth}
            height={h}
            fill="var(--color-primary)"
            rx={1}
          >
            <title>{`${d.date}: ${d.pageviews}`}</title>
          </rect>
        );
      })}
      <text x={0} y={height + 12} fontSize={10} fill="var(--color-text-secondary)">
        {days[0]?.date}
      </text>
      <text
        x={width}
        y={height + 12}
        fontSize={10}
        textAnchor="end"
        fill="var(--color-text-secondary)"
      >
        {days[days.length - 1]?.date}
      </text>
    </svg>
  );
}

function TopTable({ title, nameHeader, rows }: { title: string; nameHeader: string; rows: TopEntry[] }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body">
        <h3 style={{ marginBottom: 8 }}>{title}</h3>
        {rows.length === 0 ? (
          <p style={{ color: "var(--color-text-secondary)" }}>{es.stats.noData}</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{nameHeader}</th>
                  <th style={{ textAlign: "right" }}>{es.stats.visits}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td style={{ wordBreak: "break-all" }}>{r.name}</td>
                    <td style={{ textAlign: "right" }}>{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SiteStats({ siteId }: { siteId: number }) {
  const { user } = useAuth();
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    const now = Date.now();
    const to = isoDay(now);
    const from = isoDay(now - (rangeDays - 1) * DAY_MS);
    setLoading(true);
    api<StatsResponse>(`/api/sites/${siteId}/stats?from=${from}&to=${to}`)
      .then((res) => {
        setData(res);
        setError("");
      })
      .catch(() => setError(es.stats.loadError))
      .finally(() => setLoading(false));
  }, [siteId, rangeDays]);

  useEffect(() => {
    load();
  }, [load]);

  // Fill missing days with zero so the chart shows the whole period.
  const series = useMemo(() => {
    if (!data) return [];
    const byDate = new Map(data.days.map((d) => [d.date, d.pageviews]));
    const out: { date: string; pageviews: number }[] = [];
    const end = Date.parse(`${data.to}T00:00:00Z`);
    for (let t = Date.parse(`${data.from}T00:00:00Z`); t <= end; t += DAY_MS) {
      const date = isoDay(t);
      out.push({ date, pageviews: byDate.get(date) ?? 0 });
    }
    return out;
  }, [data]);

  async function handleRefresh() {
    setRefreshing(true);
    setError("");
    setInfo("");
    try {
      await api(`/api/sites/${siteId}/stats/refresh`, { method: "POST" });
      setInfo(es.stats.refreshed);
      load();
    } catch {
      setError(es.stats.refreshError);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div>
      <div className="log-toolbar">
        <select
          className="form-select"
          style={{ width: "auto" }}
          value={rangeDays}
          onChange={(e) => setRangeDays(Number(e.target.value))}
          aria-label={es.stats.title}
        >
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        {user?.role === "admin" && (
          <button className="btn btn-secondary btn-sm" onClick={handleRefresh} disabled={refreshing}>
            {refreshing ? es.stats.refreshing : es.stats.refresh}
          </button>
        )}
      </div>

      <p style={{ color: "var(--color-text-secondary)", fontSize: 13, marginBottom: 12 }}>
        {es.stats.privacyNote}
      </p>

      {error && <div className="error-message">{error}</div>}
      {info && <p style={{ color: "var(--color-success)" }}>{info}</p>}

      {loading && !data ? (
        <p>{es.common.loading}</p>
      ) : data ? (
        <>
          <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
            <div className="card" style={{ flex: 1, minWidth: 160 }}>
              <div className="card-body">
                <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
                  {es.stats.pageviews}
                </div>
                <div style={{ fontSize: 28, fontWeight: 600 }}>{data.totals.pageviews}</div>
              </div>
            </div>
            <div className="card" style={{ flex: 1, minWidth: 160 }}>
              <div className="card-body">
                <div style={{ color: "var(--color-text-secondary)", fontSize: 13 }}>
                  {es.stats.uniqueVisitors}
                </div>
                <div style={{ fontSize: 28, fontWeight: 600 }}>{data.totals.uniqueVisitors}</div>
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-body">
              <h3 style={{ marginBottom: 8 }}>{es.stats.pageviewsPerDay}</h3>
              {data.days.length === 0 ? (
                <p style={{ color: "var(--color-text-secondary)" }}>{es.stats.noData}</p>
              ) : (
                <BarChart days={series} />
              )}
            </div>
          </div>

          <TopTable title={es.stats.topPaths} nameHeader={es.stats.path} rows={mergeTop(data.days, "topPaths")} />
          <TopTable
            title={es.stats.topReferrers}
            nameHeader={es.stats.referrer}
            rows={mergeTop(data.days, "topReferrers")}
          />
          <TopTable
            title={es.stats.topCountries}
            nameHeader={es.stats.country}
            rows={mergeTop(data.days, "topCountries")}
          />
        </>
      ) : null}
    </div>
  );
}
