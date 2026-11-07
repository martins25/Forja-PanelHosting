import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { CreateSite } from "./CreateSite";

function mockApi(extra?: (url: string, init?: RequestInit) => unknown) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    let body: unknown = {};
    if (url === "/api/me/accounts") body = [{ id: 1, slug: "demo", status: "active" }];
    else if (url === "/api/git-integrations") {
      body = [
        { id: 1, provider: "gitea", baseUrl: "https://git.example.org" },
        { id: 2, provider: "github", baseUrl: null },
      ];
    } else if (init?.method === "POST") body = { id: 7 };
    if (extra) body = extra(url, init) ?? body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Gitea source shows the instance selector and sends owner/repo with the integration", async () => {
  const spy = mockApi();
  render(
    <MemoryRouter>
      <CreateSite />
    </MemoryRouter>,
  );
  await screen.findByText("demo");

  expect(screen.queryByLabelText("Instancia de Gitea")).toBeNull();
  fireEvent.change(screen.getByLabelText("Origen"), { target: { value: "gitea" } });

  const instance = (await screen.findByLabelText("Instancia de Gitea")) as HTMLSelectElement;
  expect(Array.from(instance.options).map((o) => o.textContent)).toEqual([
    "Selecciona una integración",
    "https://git.example.org",
  ]);
  await waitFor(() => expect(instance.value).toBe("1"));

  fireEvent.change(screen.getByLabelText("Cuenta"), { target: { value: "1" } });
  fireEvent.change(screen.getByPlaceholderText("Ej: miapp.ejemplo.com"), { target: { value: "app.example.com" } });
  fireEvent.change(screen.getByLabelText("Repositorio Gitea"), { target: { value: "owner/repo" } });
  fireEvent.click(screen.getByText("Crear sitio", { selector: "button" }));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post![1]!.body))).toMatchObject({
      source: "gitea",
      repo: "owner/repo",
      gitIntegrationId: 1,
    });
  });
});

test("GitHub source does not send an integration", async () => {
  const spy = mockApi();
  render(
    <MemoryRouter>
      <CreateSite />
    </MemoryRouter>,
  );
  await screen.findByText("demo");

  fireEvent.change(screen.getByLabelText("Cuenta"), { target: { value: "1" } });
  fireEvent.change(screen.getByPlaceholderText("Ej: miapp.ejemplo.com"), { target: { value: "app.example.com" } });
  fireEvent.change(screen.getByLabelText("Repositorio GitHub"), { target: { value: "https://github.com/u/r" } });
  fireEvent.click(screen.getByText("Crear sitio", { selector: "button" }));

  await waitFor(() => {
    const post = spy.mock.calls.find(([, init]) => init?.method === "POST");
    const body = JSON.parse(String(post![1]!.body));
    expect(body.source).toBe("github");
    expect(body.gitIntegrationId).toBeUndefined();
  });
});
