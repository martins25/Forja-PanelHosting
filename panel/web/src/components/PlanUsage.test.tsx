import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PlanLimitNotice, PlanUsageWidget } from "./PlanUsage";
import { usageLevel, type PlanUsageData } from "./usePlanUsage";

const usage = (sites: number, databases: number): PlanUsageData => ({
  sites: { current: sites, max: 5 },
  databases: { current: databases, max: 3 },
  cpu: 1000,
  memory: 512,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("usageLevel flags 80 % as near and the limit as full", () => {
  expect(usageLevel(3, 5)).toBe("ok");
  expect(usageLevel(4, 5)).toBe("near");
  expect(usageLevel(5, 5)).toBe("full");
  expect(usageLevel(0, 0)).toBe("ok");
});

test("notice is hidden below the threshold and shown near or at the limit", () => {
  const { rerender } = render(<PlanLimitNotice usage={usage(1, 0)} resource="sites" />);
  expect(screen.queryByRole("alert")).toBeNull();

  rerender(<PlanLimitNotice usage={usage(4, 0)} resource="sites" />);
  expect(screen.getByRole("alert").textContent).toContain("cerca del límite");

  rerender(<PlanLimitNotice usage={usage(0, 3)} resource="databases" />);
  expect(screen.getByRole("alert").textContent).toContain("Has alcanzado el límite de bases de datos");
});

test("widget shows usage of the account from the API", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(usage(2, 1)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  render(<PlanUsageWidget accounts={[{ id: 1, slug: "demo" }]} />);
  expect(await screen.findByText("2 / 5")).toBeTruthy();
  expect(screen.getByText("1 / 3")).toBeTruthy();
  expect(screen.getByText(/1000 milicores/)).toBeTruthy();
});
