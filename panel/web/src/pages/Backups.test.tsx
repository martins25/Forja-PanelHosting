import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { Backups } from "./Backups";

const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "client" }));
vi.mock("../context/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "u@forja.dev", role: auth.role, hasTOTP: true } }),
}));

function mockApi(sync: { status: number; body: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    let status = 200;
    let body: unknown = {};
    if (url === "/api/me/accounts") body = [{ id: 1, slug: "demo" }];
    else if (url === "/api/accounts/1/backups" && !init?.method) body = [];
    else if (url === "/api/accounts/1/backups/sync-remote") ({ status, body } = sync);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
}

afterEach(() => {
  auth.role = "admin";
  cleanup();
  vi.restoreAllMocks();
});

test("admin syncs the account to the remote", async () => {
  const spy = mockApi({ status: 200, body: { ok: true, snapshotsCopied: 2 } });
  render(<Backups />);
  fireEvent.click(await screen.findByText("Sincronizar a remoto"));
  expect(await screen.findByText("Sincronización completada (2 snapshots copiados)")).toBeDefined();
  expect(spy.mock.calls.some(([u, i]) => u === "/api/accounts/1/backups/sync-remote" && i?.method === "POST")).toBe(true);
});

test("explains when no remote is configured", async () => {
  mockApi({ status: 409, body: { error: { code: "NO_REMOTE", message: "No enabled backup remote is configured" } } });
  render(<Backups />);
  fireEvent.click(await screen.findByText("Sincronizar a remoto"));
  await waitFor(() =>
    expect(screen.getByText("No hay ningún remoto de copia externa activo. Configúralo en Copia externa.")).toBeDefined(),
  );
});

test("clients do not see the sync button", async () => {
  auth.role = "client";
  mockApi({ status: 200, body: {} });
  render(<Backups />);
  await screen.findByText("Crear backup");
  expect(screen.queryByText("Sincronizar a remoto")).toBeNull();
});
