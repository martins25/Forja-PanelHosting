import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import SiteCertificate, { type CertificateData } from "./SiteCertificate";

const cert: CertificateData = {
  id: 1,
  siteId: 5,
  domain: "acct1.example.com",
  provider: "letsencrypt",
  status: "active",
  issuedAt: "2026-11-01T00:00:00Z",
  expiresAt: "2027-01-30T00:00:00Z",
  autoRenew: true,
};

type Call = { url: string; method: string };

function mockApi(calls: Call[], routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    calls.push({ url, method });
    const handler = routes[`${method} ${url}`];
    if (!handler) throw new Error(`unexpected ${method} ${url}`);
    return handler();
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("without a certificate it offers to request one", async () => {
  const calls: Call[] = [];
  mockApi(calls, {
    "GET /api/sites/5/certificate": () => json({ error: { code: "NO_CERTIFICATE", message: "x" } }, 404),
    "POST /api/sites/5/certificate": () => json({ ...cert, status: "pending", issuedAt: null, expiresAt: null }, 201),
  });
  render(<SiteCertificate siteId={5} />);

  fireEvent.click(await screen.findByText("Solicitar certificado"));
  expect(await screen.findByText("Pendiente")).toBeTruthy();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "GET /api/sites/5/certificate",
    "POST /api/sites/5/certificate",
  ]);
});

test("an active certificate shows its details and can be renewed", async () => {
  const calls: Call[] = [];
  mockApi(calls, {
    "GET /api/sites/5/certificate": () => json(cert),
    "POST /api/sites/5/certificate/renew": () => json({ ...cert, expiresAt: "2027-02-15T00:00:00Z" }),
  });
  render(<SiteCertificate siteId={5} />);

  expect(await screen.findByText("Activo")).toBeTruthy();
  expect(screen.getByText("acct1.example.com")).toBeTruthy();
  expect(screen.queryByText("Solicitar certificado")).toBeNull();

  fireEvent.click(screen.getByText("Renovar ahora"));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith("/renew") && c.method === "POST")).toBe(true));
});

test("shows a friendly message when the account has no Cloudflare connection", async () => {
  const calls: Call[] = [];
  mockApi(calls, {
    "GET /api/sites/5/certificate": () => json({ error: { code: "NO_CERTIFICATE", message: "x" } }, 404),
    "POST /api/sites/5/certificate": () => json({ error: { code: "NO_CF_CONNECTION", message: "x" } }, 409),
  });
  render(<SiteCertificate siteId={5} />);

  fireEvent.click(await screen.findByText("Solicitar certificado"));
  expect(await screen.findByText(/no tiene una conexión de Cloudflare/)).toBeTruthy();
});
