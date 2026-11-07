import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GitIntegrations } from "./GitIntegrations";

const auth = vi.hoisted(() => ({ role: "admin" as "admin" | "client" }));
vi.mock("../context/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, email: "u@forja.dev", role: auth.role, hasTOTP: true } }),
}));


const integration = {
  id: 1,
  provider: "gitea",
  baseUrl: "https://git.example.org",
  credentialsLast4: "wxyz",
  sitesCount: 2,
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

function baseHandler(items: unknown[] = [integration]): Handler {
  return (url, init) => {
    if (url === "/api/git-integrations" && !init?.method) return { body: items };
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

test("lists integrations showing only the last 4 chars of the token", async () => {
  mockApi(baseHandler());
  const { container } = render(<GitIntegrations />);

  expect(await screen.findByText("https://git.example.org")).toBeDefined();
  expect(screen.getByText("Guardado (termina en wxyz)")).toBeDefined();
  expect(screen.getByText("Gitea")).toBeDefined();
  expect(container.textContent).not.toContain("credentialsEnc");
});

test("shows the empty state", async () => {
  mockApi(baseHandler([]));
  render(<GitIntegrations />);
  expect(await screen.findByText("No hay integraciones Git todavía.")).toBeDefined();
});

test("creates a Gitea integration and clears the token from the form", async () => {
  const spy = mockApi(baseHandler());
  render(<GitIntegrations />);
  await screen.findByText("https://git.example.org");

  fireEvent.click(screen.getByText("Nueva integración"));
  fireEvent.change(screen.getByLabelText("URL de la instancia"), {
    target: { value: "https://git.nueva.org" },
  });
  fireEvent.change(screen.getByLabelText("Token de acceso"), {
    target: { value: "super-secret-token" },
  });
  fireEvent.click(screen.getByText("Crear integración"));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      provider: "gitea",
      baseUrl: "https://git.nueva.org",
      credentials: "super-secret-token",
    });
  });
  await waitFor(() => expect(screen.queryByLabelText("Token de acceso")).toBeNull());
});

test("GitHub integrations do not send a base URL", async () => {
  const spy = mockApi(baseHandler());
  render(<GitIntegrations />);
  await screen.findByText("https://git.example.org");

  fireEvent.click(screen.getByText("Nueva integración"));
  fireEvent.change(screen.getByLabelText("Proveedor"), { target: { value: "github" } });
  expect(screen.queryByLabelText("URL de la instancia")).toBeNull();
  fireEvent.change(screen.getByLabelText("Token de acceso"), {
    target: { value: "ghp_abcdefghijkl" },
  });
  fireEvent.click(screen.getByText("Crear integración"));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      provider: "github",
      credentials: "ghp_abcdefghijkl",
    });
  });
});

test("shows the API error and clears the token", async () => {
  mockApi((url, init) => {
    if (init?.method === "POST") {
      return { status: 400, body: { error: { code: "INVALID_BASE_URL", message: "baseUrl no válida" } } };
    }
    return baseHandler()(url, init);
  });
  render(<GitIntegrations />);
  await screen.findByText("https://git.example.org");

  fireEvent.click(screen.getByText("Nueva integración"));
  fireEvent.change(screen.getByLabelText("URL de la instancia"), { target: { value: "http://x" } });
  fireEvent.change(screen.getByLabelText("Token de acceso"), { target: { value: "super-secret-token" } });
  fireEvent.click(screen.getByText("Crear integración"));

  expect(await screen.findByText("baseUrl no válida")).toBeDefined();
  expect((screen.getByLabelText("Token de acceso") as HTMLInputElement).value).toBe("");
});

test("deletes an integration after confirming", async () => {
  const spy = mockApi((url, init) => {
    if (init?.method === "DELETE") return { status: 204 };
    return baseHandler()(url, init);
  });
  render(<GitIntegrations />);
  await screen.findByText("https://git.example.org");

  fireEvent.click(screen.getByText("Eliminar"));
  await waitFor(() =>
    expect(spy.mock.calls.some(([u, i]) => u === "/api/git-integrations/1" && i?.method === "DELETE")).toBe(true),
  );
});

test("clients can only add GitHub integrations", async () => {
  auth.role = "client";
  mockApi(baseHandler([]));
  render(<GitIntegrations />);
  fireEvent.click(await screen.findByText("Nueva integración"));
  const select = (await screen.findByLabelText("Proveedor")) as HTMLSelectElement;
  expect(Array.from(select.options).map((o) => o.value)).toEqual(["github"]);
  expect(select.value).toBe("github");
});
