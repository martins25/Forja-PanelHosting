import { count, eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { accounts, databases, plans, sites } from "../db/schema.js";

export type LimitedResource = "sites" | "databases";

export interface PlanLimitResult {
  allowed: boolean;
  current: number;
  max: number;
}

export interface AccountPlan {
  account: typeof accounts.$inferSelect;
  plan: typeof plans.$inferSelect;
}

/** Loads an account and its plan. Returns null if either is missing. */
export function loadAccountPlan(accountId: number): AccountPlan | null {
  const db = getDB();
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || account.planId == null) return null;
  const plan = db.select().from(plans).where(eq(plans.id, account.planId)).get();
  if (!plan) return null;
  return { account, plan };
}

/** Counts the resources of the given kind that belong to the account. */
export function countResource(accountId: number, resource: LimitedResource): number {
  const db = getDB();
  const table = resource === "sites" ? sites : databases;
  const [row] = db
    .select({ value: count() })
    .from(table)
    .where(eq(table.accountId, accountId))
    .all();
  return row?.value ?? 0;
}

export function planMax(plan: typeof plans.$inferSelect, resource: LimitedResource): number {
  return resource === "sites" ? plan.maxSites : plan.maxDatabases;
}

/**
 * Checks whether the account can create one more resource of the given kind.
 * Returns null when the account or its plan does not exist.
 */
export function checkPlanLimit(
  accountId: number,
  resource: LimitedResource,
): PlanLimitResult | null {
  const loaded = loadAccountPlan(accountId);
  if (!loaded) return null;
  const current = countResource(accountId, resource);
  const max = planMax(loaded.plan, resource);
  return { allowed: current < max, current, max };
}
