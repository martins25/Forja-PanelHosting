import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface PlanUsageData {
  sites: { current: number; max: number };
  databases: { current: number; max: number };
  cpu: number;
  memory: number;
}

/** Returns "ok" below 80 %, "near" from 80 % and "full" when the limit is reached. */
export function usageLevel(current: number, max: number): "ok" | "near" | "full" {
  if (!(max > 0)) return "ok";
  if (current >= max) return "full";
  return current / max >= 0.8 ? "near" : "ok";
}

function isUsage(data: unknown): data is PlanUsageData {
  const d = data as Partial<PlanUsageData> | null;
  return !!d && typeof d.sites?.max === "number" && typeof d.databases?.max === "number";
}

/** Loads the plan usage of an account. Resolves to null when unavailable. */
export function usePlanUsage(accountId: number | string | null): PlanUsageData | null {
  const [state, setState] = useState<{ key: string; data: PlanUsageData | null } | null>(null);
  const key = accountId ? String(accountId) : "";

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    api<unknown>(`/api/accounts/${key}/usage`)
      .then((data) => {
        if (!cancelled) setState({ key, data: isUsage(data) ? data : null });
      })
      .catch(() => {
        if (!cancelled) setState({ key, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return state && state.key === key ? state.data : null;
}
