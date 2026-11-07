import { describe, it, expect, vi } from "vitest";
import { buildApp } from "../app.js";

describe("GET /api/system", () => {
  it("returns system info from the agent", async () => {
    const app = await buildApp({
      agentClient: {
        callAction: vi.fn().mockResolvedValue({
          ok: true,
          result: { hostname: "test", cpus: 4, os: "linux" },
        }),
      } as never,
      skipRateLimit: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/system",
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.hostname).toBe("test");
    expect(body.cpus).toBe(4);
  });

  it("returns 502 when agent fails", async () => {
    const app = await buildApp({
      agentClient: {
        callAction: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: "EXECUTE", message: "failed" },
        }),
      } as never,
      skipRateLimit: true,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/system",
    });

    expect(res.statusCode).toBe(502);
  });
});
