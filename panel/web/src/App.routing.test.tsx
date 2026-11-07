import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./App";

type Role = "admin" | "client";
interface Account {
  id: number;
  slug: string;
  status: string;
}

function site(id: number, accountId: number, domain: string) {
  return {
    id,
    accountId,
    primaryDomain: domain,
    runtime: "node",
    runtimeVersion: "22",
    mode: "online",
    lastDeploy: null,
  };
}

function setup(role: Role, path: string, accounts: Account[] = []) {
  window.history.pushState({}, "", path);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    let body: unknown = {};
    if (url === "/api/auth/me") {
      body = {
        user: { id: 1, email: `${role}@forja.dev`, role, hasTOTP: true },
        csrfToken: "csrf",
      };
    } else if (url === "/api/me/accounts") body = accounts;
    else if (url === "/api/sites") {
      body = [site(1, 1, "uno.example.com"), site(2, 2, "dos.example.com")].filter(
        (s) => role === "admin" || accounts.some((a) => a.id === s.accountId),
      );
    } else if (url.startsWith("/api/accounts/") && url.includes("/files")) {
      body = { entries: [], path: "." };
    } else if (url.startsWith("/api/audit")) {
      body = { data: [], page: 1, limit: 25, total: 0, totalPages: 1 };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return render(<App />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const demo: Account = { id: 1, slug: "demo", status: "active" };
const otra: Account = { id: 2, slug: "otra", status: "active" };

test("client sidebar only shows client sections", async () => {
  setup("client", "/", [demo]);
  await screen.findByText("uno.example.com");
  const nav = screen.getByRole("navigation", { name: "Navegación" });
  const labels = Array.from(nav.querySelectorAll("a")).map((a) => a.textContent);
  expect(labels).toEqual([
    "Sitios",
    "Bases de datos",
    "Archivos",
    "Backups",
    "Cloudflare",
    "GitHub",
    "Alertas",
  ]);
  expect(screen.queryByText("Auditoría")).toBeNull();
});

test("admin sidebar keeps the audit link", async () => {
  setup("admin", "/");
  await screen.findByText("Auditoría");
});

test("client is redirected away from admin-only routes", async () => {
  setup("client", "/audit", [demo]);
  await screen.findByText("uno.example.com");
  expect(window.location.pathname).toBe("/");
  expect(screen.queryByText("Auditoría")).toBeNull();
});

test("admin can open the audit page", async () => {
  setup("admin", "/audit");
  await waitFor(() => expect(screen.getAllByText("Auditoría").length).toBeGreaterThan(1));
  expect(window.location.pathname).toBe("/audit");
});

test("client with a single account sees no account selector", async () => {
  setup("client", "/", [demo]);
  await screen.findByText("uno.example.com");
  expect(screen.queryByRole("group", { name: "Tus cuentas" })).toBeNull();
});

test("client with several accounts gets the account list and can filter", async () => {
  setup("client", "/", [demo, otra]);
  await screen.findByRole("group", { name: "Tus cuentas" });
  expect(screen.getByText("uno.example.com")).toBeDefined();
  expect(screen.getByText("dos.example.com")).toBeDefined();

  fireEvent.click(screen.getByText("otra"));
  await waitFor(() => expect(screen.queryByText("uno.example.com")).toBeNull());
  expect(screen.getByText("dos.example.com")).toBeDefined();
});

test("client without accounts sees an explanatory message", async () => {
  setup("client", "/", []);
  await screen.findByText(/ninguna cuenta asignada/);
  expect(screen.queryByText("Crear sitio")).toBeNull();
});

test("files section goes straight to the only account", async () => {
  setup("client", "/files", [demo]);
  await waitFor(() => expect(window.location.pathname).toBe("/accounts/1/files"));
});

test("files section lists accounts when there are several", async () => {
  setup("client", "/files", [demo, otra]);
  await screen.findByText("Elige la cuenta cuyos archivos quieres gestionar:");
  expect(window.location.pathname).toBe("/files");
});
