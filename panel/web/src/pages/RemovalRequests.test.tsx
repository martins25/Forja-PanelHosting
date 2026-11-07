import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RemovalRequests } from "./RemovalRequests";

const item = {
  id: 7,
  siteId: 1,
  accountId: 1,
  accountSlug: "acct1",
  domain: "acct1.example.com",
  requestedBy: 2,
  requestedByEmail: "a@forja.dev",
  reason: "Ya no lo necesito",
  status: "open",
  createdAt: "2026-11-01T10:00:00.000Z",
  reviewedAt: null,
};

function mockApi(calls: { url: string; init?: RequestInit }[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const body = init?.method === "PATCH" ? { ...item, status: "done" } : [item];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("lists pending requests and approves one", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  mockApi(calls);
  render(<RemovalRequests />);

  expect(await screen.findByText("acct1.example.com")).toBeTruthy();
  expect(screen.getByText("a@forja.dev")).toBeTruthy();
  expect(calls[0].url).toBe("/api/removal-requests?status=open");

  fireEvent.click(screen.getByText("Aprobar y desactivar"));
  await waitFor(() => {
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(patch?.url).toBe("/api/removal-requests/7");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ status: "done" });
  });
});

test("rejects a request", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  mockApi(calls);
  render(<RemovalRequests />);
  fireEvent.click(await screen.findByText("Rechazar"));
  await waitFor(() => {
    const patch = calls.find((c) => c.init?.method === "PATCH");
    expect(JSON.parse(String(patch?.init?.body))).toEqual({ status: "rejected" });
  });
});
