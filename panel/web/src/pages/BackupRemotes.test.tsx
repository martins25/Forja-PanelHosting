import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { BackupRemotes } from "./BackupRemotes";

const remote = {
  id: 1,
  name: "R2 principal",
  kind: "r2",
  endpoint: "https://abc123.r2.cloudflarestorage.com",
  bucket: "forja-backups",
  region: "auto",
  enabled: true,
  accessKeyLast4: "MPLE",
  secretKeyLast4: "EKEY",
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

const list = (remotes: unknown[] = [remote]): Handler => (url, init) =>
  url === "/api/backup-remotes" && !init?.method ? { body: remotes } : { body: {} };

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("lists remotes showing only the last 4 chars of the keys", async () => {
  mockApi(list());
  const { container } = render(<BackupRemotes />);
  expect(await screen.findByText("R2 principal")).toBeDefined();
  expect(screen.getByText("Guardadas (terminan en MPLE / EKEY)")).toBeDefined();
  expect(container.textContent).not.toContain("accessKeyEnc");
});

test("shows the empty state", async () => {
  mockApi(list([]));
  render(<BackupRemotes />);
  expect(await screen.findByText("No hay remotos configurados.")).toBeDefined();
});

test("creates a remote with the snake_case body and clears the keys", async () => {
  const spy = mockApi(list());
  render(<BackupRemotes />);
  await screen.findByText("R2 principal");

  fireEvent.click(screen.getByText("Nuevo remoto"));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Segundo" } });
  fireEvent.change(screen.getByLabelText("Endpoint"), {
    target: { value: "https://s3.eu-west-1.amazonaws.com" },
  });
  fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "mi-bucket" } });
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AKIAIOSFODNN7EXAMPLE" } });
  fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "SECRETSECRETSECRET1234" } });
  fireEvent.click(screen.getByText("Crear remoto"));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toEqual({
      name: "Segundo",
      kind: "r2",
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      bucket: "mi-bucket",
      region: "auto",
      access_key: "AKIAIOSFODNN7EXAMPLE",
      secret_key: "SECRETSECRETSECRET1234",
    });
  });
  await waitFor(() => expect(screen.queryByLabelText("Secret key")).toBeNull());
});

test("keys are not kept in the form after a failed creation", async () => {
  mockApi((url, init) => {
    if (init?.method === "POST") return { status: 400, body: { error: { code: "INVALID_BODY", message: "Invalid remote data" } } };
    return list()(url, init);
  });
  render(<BackupRemotes />);
  await screen.findByText("R2 principal");
  fireEvent.click(screen.getByText("Nuevo remoto"));
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "X" } });
  fireEvent.change(screen.getByLabelText("Endpoint"), { target: { value: "https://s3.example.com" } });
  fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "bucket" } });
  fireEvent.change(screen.getByLabelText("Access key"), { target: { value: "AKIAIOSFODNN7EXAMPLE" } });
  fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "SECRETSECRETSECRET1234" } });
  fireEvent.click(screen.getByText("Crear remoto"));

  expect(await screen.findByText("Invalid remote data")).toBeDefined();
  expect((screen.getByLabelText("Secret key") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Access key") as HTMLInputElement).value).toBe("");
});

test("tests the connection and reports success and failure", async () => {
  let ok = true;
  mockApi((url, init) => {
    if (url === "/api/backup-remotes/1/test") {
      return ok ? { body: { ok: true } } : { status: 502, body: { error: { code: "EXECUTE", message: "Agent action failed" } } };
    }
    return list()(url, init);
  });
  render(<BackupRemotes />);
  await screen.findByText("R2 principal");

  fireEvent.click(screen.getByText("Probar conexión"));
  expect(await screen.findByText("Conexión correcta con «R2 principal»")).toBeDefined();

  ok = false;
  fireEvent.click(screen.getByText("Probar conexión"));
  expect(await screen.findByText("No se pudo conectar con «R2 principal»")).toBeDefined();
});

test("disables and deletes a remote", async () => {
  const spy = mockApi(list());
  render(<BackupRemotes />);
  await screen.findByText("R2 principal");

  fireEvent.click(screen.getByText("Desactivar"));
  await waitFor(() => {
    const patch = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/backup-remotes/1");
    expect(JSON.parse(String(patch![1]!.body))).toEqual({ enabled: false });
  });

  fireEvent.click(screen.getByText("Eliminar"));
  await waitFor(() => {
    expect(spy.mock.calls.some(([u, init]) => u === "/api/backup-remotes/1" && init?.method === "DELETE")).toBe(true);
  });
});
