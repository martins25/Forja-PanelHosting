import { buildApp } from "./app.js";
import { AgentClient } from "./agent/client.js";
import { migrate } from "./db/connection.js";

migrate();

const agentSocket = process.env.FORJA_AGENT_SOCKET ?? "/run/forja/agent.sock";
const agentClient = new AgentClient(agentSocket);

const app = await buildApp({ agentClient, logger: { level: "error" } });

await app.listen({ host: "127.0.0.1", port: 7000 });
