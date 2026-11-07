import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import {
  sites,
  domains,
  accounts,
  plans,
  deployments,
  webhookDeliveries,
} from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { decryptSecret } from "../crypto/secrets.js";
import { logAudit } from "../audit/log.js";
import { fireAlert } from "../alerts/engine.js";
import { buildCaddySyncPayload } from "./sites.js";
import { getSiteLatestCommit } from "../git/commits.js";
import { loadDecryptedEnvVars } from "./envvars.js";
import type { DeployQueue } from "../deploy/queue.js";
import { isCommitSha } from "../validation.js";

interface HookProvider {
  provider: "github" | "gitea";
  signatureHeader: string;
  deliveryHeader: string;
  eventHeader: string;
  /** GitHub prefixes the hex digest with `sha256=`, Gitea sends it bare. */
  signaturePrefix: string;
}

const hookProviders: HookProvider[] = [
  {
    provider: "github",
    signatureHeader: "x-hub-signature-256",
    deliveryHeader: "x-github-delivery",
    eventHeader: "x-github-event",
    signaturePrefix: "sha256=",
  },
  {
    provider: "gitea",
    signatureHeader: "x-gitea-signature",
    deliveryHeader: "x-gitea-delivery",
    eventHeader: "x-gitea-event",
    signaturePrefix: "",
  },
];

const BRANCH_REF_PREFIX = "refs/heads/";
const DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_COMMIT_MESSAGE_LENGTH = 500;

interface HooksOpts {
  agentClient: AgentClient;
  deployQueue: DeployQueue;
}

export async function hookRoutes(app: FastifyInstance, opts: HooksOpts) {
  const agent = opts.agentClient;
  const queue = opts.deployQueue;

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  for (const cfg of hookProviders) {
    app.post(
      `/hooks/${cfg.provider}/:siteId`,
      { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
      async (request, reply) => {
      const { siteId: siteIdStr } = request.params as { siteId: string };
      const siteId = /^[0-9]{1,9}$/.test(siteIdStr) ? Number(siteIdStr) : NaN;
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      // Providers send JSON; the signature is only meaningful over the raw JSON body.
      if (!/^application\/json\s*(;|$)/i.test(request.headers["content-type"] ?? "")) {
        return reply.status(415).send({
          error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" },
        });
      }

      const rawBody = request.body as Buffer;
      const signature = request.headers[cfg.signatureHeader] as
        | string
        | undefined;
      const deliveryId = request.headers[cfg.deliveryHeader] as
        | string
        | undefined;
      const event = request.headers[cfg.eventHeader] as string | undefined;

      if (!signature || !deliveryId) {
        return reply.status(400).send({
          error: {
            code: "MISSING_HEADERS",
            message: "Missing signature or delivery headers",
          },
        });
      }

      if (!DELIVERY_ID_RE.test(deliveryId)) {
        return reply.status(400).send({
          error: { code: "INVALID_HEADERS", message: "Invalid delivery header" },
        });
      }

      const db = getDB();

      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      if (site.source && site.source !== cfg.provider) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      if (!site.webhookSecretEnc) {
        return reply.status(400).send({
          error: {
            code: "NO_WEBHOOK_SECRET",
            message: "Site has no webhook secret configured",
          },
        });
      }

      let secret: string;
      try {
        secret = decryptSecret(site.webhookSecretEnc);
      } catch {
        return reply.status(500).send({
          error: {
            code: "DECRYPT_FAILED",
            message: "Failed to decrypt webhook secret",
          },
        });
      }

      const expected = cfg.signaturePrefix + createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      const received = cfg.signaturePrefix ? signature : signature.toLowerCase();
      // Compare bytes, not UTF-16 lengths: a header with non-ASCII characters
      // can have the right string length and the wrong byte length, and
      // timingSafeEqual throws on unequal lengths.
      const receivedBuf = Buffer.from(received);
      const expectedBuf = Buffer.from(expected);
      const signatureOk =
        receivedBuf.length === expectedBuf.length && timingSafeEqual(receivedBuf, expectedBuf);

      if (!signatureOk) {
        logAudit({
          actorUserId: 0,
          actorKind: "webhook",
          action: "webhook.receive",
          targetType: "site",
          targetId: String(siteId),
          result: "error",
          errorCode: "INVALID_SIGNATURE",
        });
        return reply.status(401).send({
          error: { code: "INVALID_SIGNATURE", message: "Signature mismatch" },
        });
      }

      // Only deliveries with a valid signature are recorded: unsigned requests
      // must not be able to fill the table.
      db.insert(webhookDeliveries)
        .values({
          provider: cfg.provider,
          deliveryId,
          siteId,
          signatureOk,
          processed: false,
        })
        .run();

      const existingDelivery = db
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.provider, cfg.provider),
            eq(webhookDeliveries.deliveryId, deliveryId),
          ),
        )
        .all();
      if (existingDelivery.length > 1) {
        return reply.send({ status: "already_processed" });
      }

      if (event !== "push") {
        return reply.send({ status: "ignored", reason: "not a push event" });
      }

      let payload: {
        ref?: unknown;
        head_commit?: { id?: unknown; message?: unknown } | null;
      };
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "Invalid JSON payload" } });
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "Invalid JSON payload" } });
      }

      const headCommit = payload.head_commit ?? undefined;
      if (headCommit?.id !== undefined && !isCommitSha(headCommit.id)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "Invalid commit id" } });
      }

      // The repository, branch and commands deployed are always the ones stored
      // for the site; only the pushed ref and commit id are read from the payload.
      const pushBranch =
        typeof payload.ref === "string" && payload.ref.startsWith(BRANCH_REF_PREFIX)
          ? payload.ref.slice(BRANCH_REF_PREFIX.length)
          : undefined;
      if (pushBranch !== site.branch) {
        return reply.send({
          status: "ignored",
          reason: "branch mismatch",
        });
      }

      if (!site.autodeploy) {
        return reply.send({ status: "ignored", reason: "autodeploy disabled" });
      }

      db.update(webhookDeliveries)
        .set({ processed: true })
        .where(eq(webhookDeliveries.deliveryId, deliveryId))
        .run();

      const commitSha = (headCommit?.id as string | undefined) ?? (await getSiteLatestCommit(site));
      const commitMessage =
        typeof headCommit?.message === "string"
          ? headCommit.message.slice(0, MAX_COMMIT_MESSAGE_LENGTH)
          : undefined;

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, site.accountId))
        .get();
      const plan = account?.planId
        ? db.select().from(plans).where(eq(plans.id, account.planId)).get()
        : null;

      queue.enqueue(siteId, { siteId, commitSha, commitMessage, trigger: "webhook" }, async (req) => {
        const currentPort = site.internalPort ?? 10000;
        const targetPort = currentPort % 2 === 0 ? currentPort + 1 : currentPort - 1;
        const currentSlot = currentPort % 2 === 0 ? "blue" : "green";
        const domSafe = site.primaryDomain.replace(/\./g, "-");
        const oldContainer = `fj-${account!.slug}-${domSafe}-${currentSlot}`;

        const hookEnvVars = loadDecryptedEnvVars(req.siteId);

        const deployRes = await agent.callAction("site.deploy", {
          account_slug: account!.slug,
          domain: site.primaryDomain,
          runtime: site.runtime,
          runtime_version: site.runtimeVersion ?? "22",
          repo: site.repo,
          branch: site.branch,
          commit: req.commitSha,
          install_cmd: site.installCmd ?? "npm ci",
          build_cmd: site.buildCmd ?? "",
          start_cmd: site.startCmd ?? "npm start",
          target_port: targetPort,
          old_container: oldContainer,
          cpu_millis: plan?.cpuMillis ?? 1000,
          memory_mb: plan?.memoryMb ?? 512,
          env_vars: hookEnvVars,
        });

        const deployStatus = deployRes.ok ? "succeeded" : "failed";
        const hookLogPath = deployRes.ok
          ? (deployRes.result as { log_path?: string })?.log_path ?? null
          : null;

        db.insert(deployments)
          .values({
            siteId: req.siteId,
            commitSha: req.commitSha,
            commitMessage: req.commitMessage ?? null,
            trigger: "webhook",
            status: deployStatus,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            logPath: hookLogPath,
          })
          .run();

        const activePort = (deployRes.result as { active_port?: unknown } | undefined)?.active_port;
        if (deployRes.ok && Number.isInteger(activePort)) {
          db.update(sites)
            .set({ internalPort: activePort as number })
            .where(eq(sites.id, req.siteId))
            .run();
        }

        const allSitesRows = db
          .select()
          .from(sites)
          .innerJoin(accounts, eq(sites.accountId, accounts.id))
          .all();
        const allDomains = db.select().from(domains).all();

        await agent.callAction("caddy.sync", {
          sites: buildCaddySyncPayload(allSitesRows, allDomains),
          panel_port: 7000,
        });

        logAudit({
          actorUserId: 0,
          actorKind: "webhook",
          action: "site.deploy",
          targetType: "site",
          targetId: String(req.siteId),
          result: deployRes.ok ? "ok" : "error",
          errorCode: deployRes.ok ? undefined : (deployRes.error?.code ?? "DEPLOY_FAILED"),
        });

        if (!deployRes.ok) {
          fireAlert("deploy_failed", {
            accountId: site.accountId,
            message: `Deploy failed for ${site.primaryDomain} (${deployRes.error?.code ?? "DEPLOY_FAILED"})`,
          });
        }
      });

      logAudit({
        actorUserId: 0,
        actorKind: "webhook",
        action: "webhook.receive",
        targetType: "site",
        targetId: String(siteId),
        result: "ok",
      });

      return reply.send({ status: "accepted", delivery_id: deliveryId });
      },
    );
  }
}
