import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CloudflareConnections } from "./CloudflareConnections";

const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "client" }));
vi.mock("../context/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "u@forja.dev", role: auth.role, hasTOTP: true } }),
}));


const TUNNEL_ID = "6ff42ae2-765d-4adf-8112-31c55c1551ef";

const connection = {
  id: 1,
  name: "Principal",
  cfAccountId: "a1".repeat(16),
  tunnelId: TUNNEL_ID,
  status: "pending",
  apiTokenLast4: "wxyz",
  tunnelTokenLast4: "9f2a",
  accounts: [{ id: 1, slug: "demo" }],
};

type Handler = (url: string, init?: RequestInit) => { status?: number; body?: unknown };

function mockApi(handler: Handler) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const { status = 200, body = {} } = handler(String(input), init);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
}

function baseHandler(connections: unknown[] = [connection]): Handler {
  return (url, init) => {
    if (url === "/api/cf-connections" && !init?.method) return { body: connections };
    if (url === "/api/me/accounts") return { body: [{ id: 1, slug: "demo" }, { id: 2, slug: "otra" }] };
    return { body: {} };
  };
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  auth.role = "admin";
  cleanup();
  vi.restoreAllMocks();
});

test("lists connections showing only the last 4 chars of the token", async () => {
  mockApi(baseHandler());
  const { container } = render(<CloudflareConnections />);

  expect(await screen.findByText("Principal")).toBeDefined();
  expect(screen.getByText("Guardado (termina en wxyz)")).toBeDefined();
  expect(screen.getByText("Pendiente")).toBeDefined();
  expect(screen.getByText("demo")).toBeDefined();
  expect(container.textContent).not.toContain("tunnelTokenEnc");
});

test("shows the empty state", async () => {
  mockApi(baseHandler([]));
  render(<CloudflareConnections />);
  expect(await screen.findByText("No hay conexiones de Cloudflare todavía.")).toBeDefined();
});

test("creates a connection with the snake_case body and clears the form", async () => {
  const spy = mockApi(baseHandler());
  render(<CloudflareConnections />);
  await screen.findByText("Principal");

  fireEvent.click(screen.getByText("Nueva conexión"));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Segunda" } });
  fireEvent.change(screen.getByLabelText("ID de cuenta de Cloudflare"), { target: { value: "b2".repeat(16) } });
  fireEvent.change(screen.getByLabelText("Token de API"), { target: { value: "cfapitoken_SECRETVALUE_wxyz" } });
  fireEvent.change(screen.getByLabelText("ID del túnel"), { target: { value: TUNNEL_ID } });
  fireEvent.change(screen.getByLabelText("Token del túnel"), { target: { value: "dG9rZW4tZGUtdHVuZWw=" } });
  fireEvent.click(screen.getByText("Crear conexión"));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(post![0]).toBe("/api/cf-connections");
    expect(JSON.parse(post![1]!.body as string)).toEqual({
      name: "Segunda",
      cf_account_id: "b2".repeat(16),
      api_token: "cfapitoken_SECRETVALUE_wxyz",
      tunnel_id: TUNNEL_ID,
      tunnel_token: "dG9rZW4tZGUtdHVuZWw=",
    });
  });
  // form closed: secrets are no longer in the DOM
  await waitFor(() => expect(screen.queryByLabelText("Token de API")).toBeNull());
});

test("shows API errors", async () => {
  mockApi((url, init) => {
    if (init?.method === "POST") return { status: 409, body: { error: { code: "TUNNEL_IN_USE", message: "A connection for this tunnel already exists" } } };
    return baseHandler()(url, init);
  });
  render(<CloudflareConnections />);
  await screen.findByText("Principal");
  fireEvent.click(screen.getByText("Nueva conexión"));
  for (const [label, value] of [
    ["Nombre", "X"],
    ["ID de cuenta de Cloudflare", "b2".repeat(16)],
    ["Token de API", "cfapitoken_SECRETVALUE_wxyz"],
    ["ID del túnel", TUNNEL_ID],
    ["Token del túnel", "dG9rZW4tZGUtdHVuZWw="],
  ]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByText("Crear conexión"));
  expect(await screen.findByText("A connection for this tunnel already exists")).toBeDefined();
  // secrets are wiped after a failed submit, the non-secret fields are kept
  expect((screen.getByLabelText("Token de API") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Token del túnel") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("X");
});

test("wipes typed tokens when the form is closed", async () => {
  mockApi(baseHandler());
  render(<CloudflareConnections />);
  await screen.findByText("Principal");

  fireEvent.click(screen.getByText("Nueva conexión"));
  fireEvent.change(screen.getByLabelText("Token de API"), { target: { value: "cfapitoken_SECRETVALUE_wxyz" } });
  fireEvent.click(screen.getByText("Nueva conexión")); // close
  fireEvent.click(screen.getByText("Nueva conexión")); // reopen

  expect((screen.getByLabelText("Token de API") as HTMLInputElement).value).toBe("");
});

test("applies the container", async () => {
  const spy = mockApi(baseHandler());
  render(<CloudflareConnections />);
  await screen.findByText("Principal");

  fireEvent.click(screen.getByText("Aplicar"));

  await waitFor(() => {
    expect(spy.mock.calls.some(([u, i]) => u === "/api/cf-connections/1/apply" && i?.method === "POST")).toBe(true);
  });
  expect(await screen.findByText("Contenedor aplicado")).toBeDefined();
});

test("syncs routes and reports a partial result", async () => {
  mockApi((url, init) => {
    if (url.endsWith("/sync-routes")) {
      return { body: { domains: [{ hostname: "a.com", status: "ok" }, { hostname: "b.com", status: "error", error: "x" }], failed: 1 } };
    }
    return baseHandler()(url, init);
  });
  render(<CloudflareConnections />);
  await screen.findByText("Principal");
  fireEvent.click(screen.getByText("Sincronizar rutas"));
  expect(await screen.findByText("Sincronización parcial: 1 dominio(s) con error")).toBeDefined();
});

test("deletes after confirmation and handles 204", async () => {
  const spy = mockApi((url, init) => {
    if (init?.method === "DELETE") return { status: 204 };
    return baseHandler()(url, init);
  });
  render(<CloudflareConnections />);
  await screen.findByText("Principal");
  fireEvent.click(screen.getByText("Eliminar"));
  await waitFor(() => {
    expect(spy.mock.calls.some(([u, i]) => u === "/api/cf-connections/1" && i?.method === "DELETE")).toBe(true);
  });
  expect(window.confirm).toHaveBeenCalled();
});

test("does not delete when the confirmation is declined", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(false);
  const spy = mockApi(baseHandler());
  render(<CloudflareConnections />);
  await screen.findByText("Principal");
  fireEvent.click(screen.getByText("Eliminar"));
  expect(spy.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
});

test("links an available account", async () => {
  const spy = mockApi(baseHandler());
  render(<CloudflareConnections />);
  await screen.findByText("Principal");

  fireEvent.change(screen.getByLabelText("Vincular cuenta Principal"), { target: { value: "2" } });
  fireEvent.click(screen.getByText("Vincular"));

  await waitFor(() => {
    const call = spy.mock.calls.find(([u]) => u === "/api/cf-connections/1/accounts");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1]!.body as string)).toEqual({ accountId: 2 });
  });
});

test("clients cannot link or unlink accounts", async () => {
  auth.role = "client";
  mockApi(baseHandler());
  render(<CloudflareConnections />);
  expect(await screen.findByText("Principal")).toBeDefined();
  expect(screen.queryByText("Desvincular")).toBeNull();
  expect(screen.queryByLabelText(/Vincular cuenta/)).toBeNull();
});
