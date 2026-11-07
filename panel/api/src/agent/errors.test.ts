import { describe, it, expect, vi } from "vitest";
import type { FastifyReply } from "fastify";
import { agentErrorCode, agentErrorMessage, agentErrorResponse } from "./errors.js";

function fakeReply() {
  const reply = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send: vi.fn((body: unknown) => {
      reply.payload = body;
      return reply;
    }),
  };
  return reply;
}

describe("agent error mapping", () => {
  it("never forwards the raw agent message", () => {
    const reply = fakeReply();
    agentErrorResponse(reply as unknown as FastifyReply, {
      error: { code: "EXECUTE", message: "open /srv/forja/accounts/x/.env: permission denied (podman 4.9.3)" },
    });
    const body = JSON.stringify(reply.payload);
    expect(reply.statusCode).toBe(502);
    expect(body).not.toContain("/srv/forja");
    expect(body).not.toContain("podman");
    expect(reply.payload).toEqual({ error: { code: "EXECUTE", message: "Agent action failed" } });
  });

  it("maps unknown codes to AGENT_ERROR", () => {
    expect(agentErrorCode({ error: { code: "WEIRD_INTERNAL", message: "x" } })).toBe("AGENT_ERROR");
    expect(agentErrorCode({})).toBe("AGENT_ERROR");
    expect(agentErrorMessage({ error: { code: "WEIRD_INTERNAL", message: "secret" } })).toBe("Agent action failed");
  });

  it("does not treat Object.prototype keys as known codes", () => {
    expect(agentErrorCode({ error: { code: "constructor", message: "x" } })).toBe("AGENT_ERROR");
    expect(agentErrorCode({ error: { code: "__proto__", message: "x" } })).toBe("AGENT_ERROR");
  });

  it("supports a custom status and extra body fields", () => {
    const reply = fakeReply();
    agentErrorResponse(reply as unknown as FastifyReply, { error: { code: "VALIDATION", message: "m" } }, {
      status: 409,
      extra: { site: { id: 1 } },
    });
    expect(reply.statusCode).toBe(409);
    expect(reply.payload).toEqual({
      error: { code: "VALIDATION", message: "Agent rejected the request" },
      site: { id: 1 },
    });
  });
});
