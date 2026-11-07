import { describe, it, expect } from "vitest";
import http from "node:http";
import { AgentClient } from "./client.js";

function createMockAgent(
  response: Record<string, unknown>,
): Promise<{ socketPath: string; close: () => void }> {
  return new Promise((resolve) => {
    const socketPath = `/tmp/forja-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });

    server.listen(socketPath, () => {
      resolve({
        socketPath,
        close: () => server.close(),
      });
    });
  });
}

describe("AgentClient", () => {
  it("calls an action and parses the response", async () => {
    const mock = await createMockAgent({
      ok: true,
      result: { hostname: "test-vm", cpus: 2 },
    });

    try {
      const client = new AgentClient(mock.socketPath);
      const res = await client.callAction("system.info");

      expect(res.ok).toBe(true);
      expect(res.result).toEqual({ hostname: "test-vm", cpus: 2 });
    } finally {
      mock.close();
    }
  });

  it("handles error responses", async () => {
    const mock = await createMockAgent({
      ok: false,
      error: { code: "UNKNOWN_ACTION", message: "not found" },
    });

    try {
      const client = new AgentClient(mock.socketPath);
      const res = await client.callAction("nonexistent");

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("UNKNOWN_ACTION");
    } finally {
      mock.close();
    }
  });

  it("rejects when the socket is unreachable", async () => {
    const client = new AgentClient("/tmp/nonexistent-socket.sock");
    await expect(client.callAction("system.info")).rejects.toThrow();
  });
});
