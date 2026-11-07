import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi, beforeEach } from "vitest";
import { App } from "./App";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: { code: "NO_SESSION" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

test("shows login page when not authenticated", async () => {
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText("Iniciar sesión")).toBeDefined();
  });
});
