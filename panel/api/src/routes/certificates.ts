import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import type { AgentClient, AgentResponse } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts, certificates, cfConnections, domains, sites } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { decryptSecret } from "../crypto/secrets.js";
import { agentErrorResponse } from "../agent/errors.js";

interface CertificateOpts {
  agentClient: AgentClient;
}

type CertificateRow = typeof certificates.$inferSelect;
type SiteRow = typeof sites.$inferSelect;

interface AgentCertResult {
  domain: string;
  status: "pending" | "active" | "expired";
  issued_at?: string;
  expires_at?: string;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Agent messages can carry internal paths or Caddy details: only a fixed message goes out. */
function agentFailure(reply: FastifyReply, res: AgentResponse) {
  return agentErrorResponse(reply, res);
}

async function callAgent<T>(
  agent: AgentClient,
  action: string,
  params: Record<string, unknown>,
): Promise<AgentResponse<T>> {
  try {
    return await agent.callAction<T>(action, params);
  } catch {
    return { ok: false, error: { code: "AGENT_UNREACHABLE", message: "Agent is not reachable" } };
  }
}

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function serialize(row: CertificateRow) {
  return {
    id: row.id,
    siteId: row.siteId,
    domain: row.domain,
    provider: row.provider,
    status: row.status,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    autoRenew: row.autoRenew,
  };
}

export async function certificateRoutes(app: FastifyInstance, opts: CertificateOpts) {
  const agent = opts.agentClient;
  const reads = { preHandler: [requireSession] };
  const writes = { preHandler: [requireSession, requireCSRF] };

  /** Resolves the site and checks the caller can reach its account (rule 6). */
  function loadSite(request: FastifyRequest, reply: FastifyReply): SiteRow | null {
    const siteId = parseId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      sendError(reply, 400, "INVALID_ID", "Invalid site ID");
      return null;
    }
    const site = getDB().select().from(sites).where(eq(sites.id, siteId)).get();
    if (!site) {
      sendError(reply, 404, "NOT_FOUND", "Site not found");
      return null;
    }
    const user = request.session!.user;
    const accountIds = getAccessibleAccountIds(user.id, user.role);
    if (accountIds && !accountIds.includes(site.accountId)) {
      sendError(reply, 403, "FORBIDDEN", "Access denied to this account");
      return null;
    }
    return site;
  }

  function findCertificate(siteId: number): CertificateRow | undefined {
    return getDB().select().from(certificates).where(eq(certificates.siteId, siteId)).get();
  }

  function applyResult(site: SiteRow, result: AgentCertResult): CertificateRow {
    const db = getDB();
    const values = {
      domain: site.primaryDomain,
      status: result.status,
      issuedAt: result.issued_at ?? null,
      expiresAt: result.expires_at ?? null,
    };
    const existing = findCertificate(site.id);
    const row = existing
      ? db.update(certificates).set(values).where(eq(certificates.id, existing.id)).returning().get()
      : db.insert(certificates).values({ siteId: site.id, ...values }).returning().get();
    // The domain list shows which certificate protects each hostname.
    db.update(domains)
      .set({ cert: "letsencrypt", certExpiresAt: values.expiresAt })
      .where(and(eq(domains.siteId, site.id), eq(domains.hostname, site.primaryDomain)))
      .run();
    return row;
  }

  function markError(site: SiteRow) {
    const db = getDB();
    const existing = findCertificate(site.id);
    if (existing) {
      db.update(certificates)
        .set({ status: "error", domain: site.primaryDomain })
        .where(eq(certificates.id, existing.id))
        .run();
    } else {
      db.insert(certificates)
        .values({ siteId: site.id, domain: site.primaryDomain, status: "error" })
        .run();
    }
  }

  /** Returns the Cloudflare API token of the account's connection, or null. */
  function accountToken(site: SiteRow): { slug: string; token: string } | null {
    const row = getDB()
      .select({ slug: accounts.slug, tokenEnc: cfConnections.apiTokenEnc })
      .from(accounts)
      .innerJoin(cfConnections, eq(accounts.cfConnectionId, cfConnections.id))
      .where(eq(accounts.id, site.accountId))
      .get();
    return row ? { slug: row.slug, token: decryptSecret(row.tokenEnc) } : null;
  }

  async function issue(
    request: FastifyRequest,
    reply: FastifyReply,
    site: SiteRow,
    action: "cert.request" | "cert.renew",
    okStatus: number,
  ) {
    const auditAction = action === "cert.request" ? "certificate.request" : "certificate.renew";
    const user = request.session!.user;
    const audit = (result: "ok" | "error", errorCode?: string) =>
      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: auditAction,
        targetType: "site",
        targetId: String(site.id),
        result,
        errorCode,
      });

    const cf = accountToken(site);
    if (!cf) {
      audit("error", "NO_CF_CONNECTION");
      return sendError(
        reply,
        409,
        "NO_CF_CONNECTION",
        "The account has no Cloudflare connection to validate the domain",
      );
    }

    const res = await callAgent<AgentCertResult>(agent, action, {
      account_slug: cf.slug,
      domain: site.primaryDomain,
      cf_api_token: cf.token,
    });
    if (!res.ok || !res.result) {
      markError(site);
      audit("error", res.error?.code ?? "AGENT_ERROR");
      return agentFailure(reply, res);
    }
    const row = applyResult(site, res.result);
    audit("ok");
    return reply.status(okStatus).send(serialize(row));
  }

  app.post("/api/sites/:siteId/certificate", writes, async (request, reply) => {
    const site = loadSite(request, reply);
    if (!site) return;
    const existing = findCertificate(site.id);
    if (existing && (existing.status === "pending" || existing.status === "active")) {
      return sendError(reply, 409, "CERTIFICATE_EXISTS", "A certificate was already requested for this site");
    }
    return issue(request, reply, site, "cert.request", existing ? 200 : 201);
  });

  app.get("/api/sites/:siteId/certificate", reads, async (request, reply) => {
    const site = loadSite(request, reply);
    if (!site) return;
    let row = findCertificate(site.id);
    if (!row) return sendError(reply, 404, "NO_CERTIFICATE", "No certificate for this site");

    // Issuance is asynchronous and Caddy renews on its own: refresh from the agent.
    if (row.status === "pending" || row.status === "active") {
      const account = getDB().select().from(accounts).where(eq(accounts.id, site.accountId)).get();
      if (account) {
        const res = await callAgent<AgentCertResult>(agent, "cert.status", {
          account_slug: account.slug,
          domain: row.domain,
        });
        if (res.ok && res.result) row = applyResult(site, res.result);
      }
    }
    return serialize(row);
  });

  app.post("/api/sites/:siteId/certificate/renew", writes, async (request, reply) => {
    const site = loadSite(request, reply);
    if (!site) return;
    if (!findCertificate(site.id)) {
      return sendError(reply, 404, "NO_CERTIFICATE", "No certificate for this site");
    }
    return issue(request, reply, site, "cert.renew", 200);
  });
}
