import type { FastifyInstance } from "fastify";
import type { AgentClient } from "../agent/client.js";
import { agentErrorMessage } from "../agent/errors.js";

export async function systemRoutes(
  app: FastifyInstance,
  opts: { agentClient: AgentClient },
) {
  app.get("/api/system", async (_request, reply) => {
    const res = await opts.agentClient.callAction("system.info");

    if (!res.ok) {
      return reply.status(502).send({
        error: agentErrorMessage(res),
      });
    }

    return reply.send(res.result);
  });
}
