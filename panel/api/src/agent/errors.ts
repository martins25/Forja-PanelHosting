import type { FastifyReply } from "fastify";
import type { AgentResponse } from "./client.js";

/**
 * Agent error messages can carry internal paths, software versions, podman or
 * Caddy output. Only a code from this closed list and the fixed message below
 * ever reach the browser; the raw agent message is never forwarded.
 */
export const AGENT_MESSAGES: Readonly<Record<string, string>> = {
  AGENT_UNREACHABLE: "Agent is not reachable",
  VALIDATION: "Agent rejected the request",
  EXECUTE: "Agent action failed",
  UNKNOWN_ACTION: "Agent action failed",
  READ_BODY: "Agent rejected the request",
  PEER_CHECK_FAILED: "Agent action failed",
  UNAUTHORIZED_PEER: "Agent action failed",
};

const FALLBACK_CODE = "AGENT_ERROR";
const FALLBACK_MESSAGE = "Agent action failed";

/** Maps whatever the agent returned to a code from the closed list. */
export function agentErrorCode(res: Pick<AgentResponse, "error">): string {
  const code = res.error?.code;
  return typeof code === "string" && Object.hasOwn(AGENT_MESSAGES, code) ? code : FALLBACK_CODE;
}

export function agentErrorMessage(res: Pick<AgentResponse, "error">): string {
  return AGENT_MESSAGES[agentErrorCode(res)] ?? FALLBACK_MESSAGE;
}

/**
 * Sends a sanitized error for a failed agent call (502 by default).
 * `extra` adds sibling fields to the body, e.g. `{ site }`.
 */
export function agentErrorResponse(
  reply: FastifyReply,
  res: Pick<AgentResponse, "error">,
  opts: { status?: number; extra?: Record<string, unknown> } = {},
) {
  return reply.status(opts.status ?? 502).send({
    error: { code: agentErrorCode(res), message: agentErrorMessage(res) },
    ...opts.extra,
  });
}
