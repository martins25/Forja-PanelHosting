import type { FastifyInstance } from "fastify";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import {
  sites,
  domains,
  accounts,
  plans,
  deployments,
  gitIntegrations,
} from "../db/schema.js";
import { eq, max, desc, inArray } from "drizzle-orm";
import {
  requireSession,
  requireCSRF,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { fireAlert } from "../alerts/engine.js";
import {
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
} from "../crypto/secrets.js";
import { loadDecryptedEnvVars } from "./envvars.js";
import { getLatestCommit, getSiteLatestCommit } from "../git/commits.js";
import { checkPlanLimit } from "../plans/limits.js";
import { agentErrorResponse } from "../agent/errors.js";
import {
  isBranch,
  isContainerCmd,
  isGithubRepoUrl,
  isHostname,
  isPublicDir,
  isRuntimeVersion,
  isDisplayText,
} from "../validation.js";

interface SitesOpts {
  agentClient: AgentClient;
}

type SiteRuntime = "node" | "php" | "python" | "static" | "docker";

const validRuntimes: SiteRuntime[] = ["node", "php", "python", "static", "docker"];

interface RuntimeDefaults {
  runtimeVersion: string;
  installCmd: string;
  startCmd: string;
  publicDir: string;
}

function runtimeDefaults(runtime: SiteRuntime): RuntimeDefaults {
  switch (runtime) {
    case "php":
      return { runtimeVersion: "8.4", installCmd: "composer install --no-dev", startCmd: "", publicDir: "public" };
    case "python":
      return { runtimeVersion: "3.13", installCmd: "pip install --no-cache-dir -r requirements.txt", startCmd: "gunicorn app:app -b 0.0.0.0:8000", publicDir: "" };
    case "static":
      return { runtimeVersion: "", installCmd: "", startCmd: "", publicDir: "public" };
    case "docker":
      return { runtimeVersion: "", installCmd: "", startCmd: "", publicDir: "" };
    default:
      return { runtimeVersion: "22", installCmd: "npm ci", startCmd: "npm start", publicDir: "" };
  }
}

interface CreateSiteBody {
  accountId: number;
  primaryDomain: string;
  runtime: SiteRuntime;
  runtimeVersion?: string;
  source?: "github" | "gitea";
  /** GitHub: full https URL. Gitea: `owner/repo` on the integration's instance. */
  repo: string;
  gitIntegrationId?: number;
  branch?: string;
  installCmd?: string;
  buildCmd?: string;
  startCmd?: string;
  publicDir?: string;
}

const GITEA_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function buildCaddySyncPayload(
  allSites: { sites: typeof sites.$inferSelect; accounts: typeof accounts.$inferSelect }[],
  allDomains: (typeof domains.$inferSelect)[],
) {
  return allSites.map(({ sites: site, accounts: account }) => ({
    domains: allDomains
      .filter((d) => d.siteId === site.id)
      .map((d) => d.hostname),
    mode: site.mode,
    internal_port: site.internalPort ?? 0,
    account_slug: account.slug,
    notice_title: site.noticeTitle ?? "",
    notice_message: site.noticeMessage ?? "",
  }));
}

/** Never let the (encrypted) webhook secret leave through a site response. */
function withoutSecrets<T extends { webhookSecretEnc?: unknown }>(site: T) {
  const { webhookSecretEnc, ...rest } = site;
  void webhookSecretEnc;
  return rest;
}

export async function siteRoutes(app: FastifyInstance, opts: SitesOpts) {
  const agent = opts.agentClient;

  app.get(
    "/api/sites",
    { preHandler: [requireSession] },
    async (request) => {
      const db = getDB();
      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      const allSites = accountIds
        ? db.select().from(sites).where(inArray(sites.accountId, accountIds.length ? accountIds : [-1])).all()
        : db.select().from(sites).all();
      const allDeployments = db
        .select()
        .from(deployments)
        .orderBy(desc(deployments.id))
        .all();

      return allSites.map((site) => {
        const siteDeploys = allDeployments.filter((d) => d.siteId === site.id);
        const lastDeploy = siteDeploys[0] ?? null;
        const { webhookSecretEnc, ...publicSite } = site;
        void webhookSecretEnc;
        return { ...publicSite, lastDeploy };
      });
    },
  );

  app.get(
    "/api/sites/:id",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const siteId = Number(id);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const db = getDB();
      const site = db
        .select()
        .from(sites)
        .where(eq(sites.id, siteId))
        .get();

      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const siteDomains = db
        .select()
        .from(domains)
        .where(eq(domains.siteId, siteId))
        .all();

      const siteDeployments = db
        .select()
        .from(deployments)
        .where(eq(deployments.siteId, siteId))
        .orderBy(desc(deployments.id))
        .all();

      const { webhookSecretEnc, ...publicSite } = site;
      void webhookSecretEnc;
      return { ...publicSite, domains: siteDomains, deployments: siteDeployments };
    },
  );

  app.post(
    "/api/sites",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const body = request.body as CreateSiteBody;

      if (!body.accountId || !body.primaryDomain || !body.repo) {
        return reply.status(400).send({
          error: {
            code: "INVALID_BODY",
            message: "accountId, primaryDomain and repo are required",
          },
        });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(body.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const runtime: SiteRuntime = body.runtime ?? "node";
      if (!validRuntimes.includes(runtime)) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Unsupported runtime" },
        });
      }

      const source = body.source ?? "github";
      if (source !== "github" && source !== "gitea") {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Unsupported source" },
        });
      }

      // First-layer whitelist validation: nothing hostile reaches the database,
      // the agent or an outgoing request (the agent validates again).
      const invalid = (message: string) =>
        reply.status(400).send({ error: { code: "INVALID_BODY", message } });
      if (!isHostname(body.primaryDomain)) {
        return invalid("primaryDomain must be a valid lowercase hostname");
      }
      if (typeof body.repo !== "string") {
        return invalid("repo must be a string");
      }
      if (source === "github" && !isGithubRepoUrl(body.repo)) {
        return invalid("repo must be https://github.com/<owner>/<repo>");
      }
      if (body.branch !== undefined && !isBranch(body.branch)) {
        return invalid("branch contains invalid characters");
      }
      if (body.runtimeVersion !== undefined && !isRuntimeVersion(runtime, body.runtimeVersion)) {
        return invalid("Unsupported runtimeVersion for this runtime");
      }
      for (const field of ["installCmd", "buildCmd", "startCmd"] as const) {
        if (body[field] !== undefined && !isContainerCmd(body[field])) {
          return invalid(`${field} contains invalid characters`);
        }
      }
      if (body.publicDir !== undefined && !isPublicDir(body.publicDir)) {
        return invalid("publicDir must be a relative directory without '..'");
      }

      const db = getDB();

      let repoURL = body.repo;
      let gitIntegrationId: number | null = null;
      let giteaToken: { baseUrl: string; token: string } | null = null;
      if (source === "gitea") {
        if (request.session!.user.role !== "admin") {
          return reply.status(403).send({
            error: { code: "FORBIDDEN", message: "Only admins can create Gitea sites" },
          });
        }
        const integration = Number.isInteger(body.gitIntegrationId)
          ? db
              .select()
              .from(gitIntegrations)
              .where(eq(gitIntegrations.id, body.gitIntegrationId!))
              .get()
          : undefined;
        if (!integration || integration.provider !== "gitea" || !integration.baseUrl) {
          return reply.status(400).send({
            error: { code: "INVALID_INTEGRATION", message: "A Gitea integration is required" },
          });
        }
        const path = body.repo.replace(/\.git$/, "");
        if (!GITEA_REPO_RE.test(path) || path.split("/").some((seg) => seg === "." || seg === "..")) {
          return reply.status(400).send({
            error: { code: "INVALID_BODY", message: "repo must be owner/repo" },
          });
        }
        repoURL = `${integration.baseUrl}/${path}.git`;
        gitIntegrationId = integration.id;
        giteaToken = {
          baseUrl: integration.baseUrl,
          token: decryptSecret(integration.credentialsEnc),
        };
      } else if (body.gitIntegrationId !== undefined) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "gitIntegrationId is only valid for Gitea" },
        });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, body.accountId))
        .get();
      if (!account) {
        return reply
          .status(404)
          .send({ error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" } });
      }
      if (account.status !== "active") {
        return reply
          .status(409)
          .send({ error: { code: "ACCOUNT_SUSPENDED", message: "Account is suspended" } });
      }

      const plan = db
        .select()
        .from(plans)
        .where(eq(plans.id, account.planId!))
        .get();
      if (!plan) {
        return reply
          .status(500)
          .send({ error: { code: "PLAN_MISSING", message: "Account plan not found" } });
      }

      const siteLimit = checkPlanLimit(body.accountId, "sites");
      if (siteLimit && !siteLimit.allowed) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "site.create",
          targetType: "account",
          targetId: String(body.accountId),
          result: "error",
          errorCode: "PLAN_LIMIT",
        });
        return reply.status(409).send({
          error: {
            code: "PLAN_LIMIT",
            message: `Maximum sites reached for this plan (${siteLimit.current}/${siteLimit.max})`,
          },
        });
      }

      const existing = db
        .select()
        .from(sites)
        .where(eq(sites.primaryDomain, body.primaryDomain))
        .get();
      if (existing) {
        return reply.status(409).send({
          error: { code: "DUPLICATE_DOMAIN", message: "Domain already in use" },
        });
      }

      const [maxPortRow] = db
        .select({ value: max(sites.internalPort) })
        .from(sites)
        .all();
      let nextPort = Math.max((maxPortRow?.value ?? 9998) + 2, 10000);
      if (nextPort % 2 !== 0) nextPort += 1;

      const defaults = runtimeDefaults(runtime);
      const runtimeVersion = body.runtimeVersion ?? defaults.runtimeVersion;
      const branchName = body.branch ?? "main";
      const installCmd = body.installCmd ?? defaults.installCmd;
      const buildCmd = body.buildCmd ?? "";
      const startCmd = body.startCmd ?? defaults.startCmd;
      const publicDir = body.publicDir ?? defaults.publicDir;

      const createRes = await agent.callAction("site.create", {
        account_slug: account.slug,
        domain: body.primaryDomain,
        runtime,
        runtime_version: runtimeVersion,
        internal_port: nextPort,
      });

      if (!createRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "site.create",
          targetType: "site",
          result: "error",
          errorCode: createRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, createRes);
      }

      const webhookSecretPlain = generateWebhookSecret();
      const webhookSecretEnc = encryptSecret(webhookSecretPlain);

      const site = db
        .insert(sites)
        .values({
          accountId: body.accountId,
          primaryDomain: body.primaryDomain,
          runtime,
          runtimeVersion: runtimeVersion || null,
          source,
          repo: repoURL,
          gitIntegrationId,
          branch: branchName,
          installCmd: installCmd || null,
          buildCmd: buildCmd || null,
          startCmd: startCmd || null,
          publicDir: publicDir || null,
          internalPort: nextPort,
          mode: "online",
          webhookSecretEnc,
        })
        .returning()
        .get();

      db.insert(domains)
        .values({
          siteId: site.id,
          hostname: body.primaryDomain,
          kind: "primary",
        })
        .run();

      let commitSha: string;
      try {
        commitSha = await getLatestCommit(repoURL, branchName, giteaToken);
      } catch {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "site.create",
          targetType: "site",
          targetId: String(site.id),
          result: "error",
          errorCode: "GIT_API_ERROR",
        });
        return reply.status(502).send({
          error: { code: "GIT_API_ERROR", message: "Failed to fetch latest commit" },
        });
      }

      const envVarsMap = loadDecryptedEnvVars(site.id);

      const deployRes = await agent.callAction("site.deploy", {
        account_slug: account.slug,
        domain: body.primaryDomain,
        runtime,
        runtime_version: runtimeVersion,
        repo: repoURL,
        branch: branchName,
        commit: commitSha,
        install_cmd: installCmd,
        build_cmd: buildCmd,
        start_cmd: startCmd,
        public_dir: publicDir,
        target_port: nextPort,
        old_container: "",
        cpu_millis: plan.cpuMillis,
        memory_mb: plan.memoryMb,
        env_vars: envVarsMap,
      });

      const deployStatus = deployRes.ok ? "succeeded" : "failed";
      const logPath = deployRes.ok
        ? (deployRes.result as { log_path?: string })?.log_path ?? null
        : null;

      db.insert(deployments)
        .values({
          siteId: site.id,
          commitSha,
          trigger: "manual",
          status: deployStatus,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          logPath,
        })
        .run();

      const activePort = (deployRes.result as { active_port?: unknown } | undefined)?.active_port;
      if (deployRes.ok && Number.isInteger(activePort)) {
        db.update(sites)
          .set({ internalPort: activePort as number })
          .where(eq(sites.id, site.id))
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
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "site.create",
        targetType: "site",
        targetId: String(site.id),
        result: "ok",
      });

      if (!deployRes.ok) {
        fireAlert("deploy_failed", {
          accountId: site.accountId,
          message: `Deploy failed for ${site.primaryDomain} (${deployRes.error?.code ?? "DEPLOY_FAILED"})`,
        });
        return agentErrorResponse(reply, deployRes, { extra: { site } });
      }

      const { webhookSecretEnc: _, ...sitePublic } = site; // eslint-disable-line @typescript-eslint/no-unused-vars
      return reply.status(201).send({
        ...sitePublic,
        webhookUrl: `/hooks/${source}/${site.id}`,
        webhookSecret: webhookSecretPlain,
      });
    },
  );

  app.post(
    "/api/sites/:id/deploy",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const siteId = Number(id);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const db = getDB();

      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, site.accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const plan = db
        .select()
        .from(plans)
        .where(eq(plans.id, account.planId!))
        .get();

      const currentPort = site.internalPort ?? 10000;
      const targetPort =
        currentPort % 2 === 0 ? currentPort + 1 : currentPort - 1;
      const currentSlot = currentPort % 2 === 0 ? "blue" : "green";
      const domSafe = site.primaryDomain.replace(/\./g, "-");
      const oldContainer = `fj-${account.slug}-${domSafe}-${currentSlot}`;

      let commitSha: string;
      try {
        commitSha = await getSiteLatestCommit(site);
      } catch {
        return reply.status(502).send({
          error: { code: "GIT_API_ERROR", message: "Failed to fetch latest commit" },
        });
      }

      const siteEnvVars = loadDecryptedEnvVars(site.id);

      const siteDefaults = runtimeDefaults(site.runtime as SiteRuntime);
      const deployRes = await agent.callAction("site.deploy", {
        account_slug: account.slug,
        domain: site.primaryDomain,
        runtime: site.runtime,
        runtime_version: site.runtimeVersion ?? siteDefaults.runtimeVersion,
        repo: site.repo,
        branch: site.branch,
        commit: commitSha,
        install_cmd: site.installCmd ?? siteDefaults.installCmd,
        build_cmd: site.buildCmd ?? "",
        start_cmd: site.startCmd ?? siteDefaults.startCmd,
        public_dir: site.publicDir ?? siteDefaults.publicDir,
        target_port: targetPort,
        old_container: oldContainer,
        cpu_millis: plan?.cpuMillis ?? 1000,
        memory_mb: plan?.memoryMb ?? 512,
        env_vars: siteEnvVars,
      });

      const deployStatus = deployRes.ok ? "succeeded" : "failed";
      const deployLogPath = deployRes.ok
        ? (deployRes.result as { log_path?: string })?.log_path ?? null
        : null;

      db.insert(deployments)
        .values({
          siteId: site.id,
          commitSha,
          trigger: "manual",
          status: deployStatus,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          logPath: deployLogPath,
        })
        .run();

      const activePort = (deployRes.result as { active_port?: unknown } | undefined)?.active_port;
      if (deployRes.ok && Number.isInteger(activePort)) {
        db.update(sites)
          .set({ internalPort: activePort as number })
          .where(eq(sites.id, site.id))
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
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "site.deploy",
        targetType: "site",
        targetId: String(site.id),
        result: deployRes.ok ? "ok" : "error",
        errorCode: deployRes.ok ? undefined : (deployRes.error?.code ?? "DEPLOY_FAILED"),
      });

      if (!deployRes.ok) {
        fireAlert("deploy_failed", {
          accountId: site.accountId,
          message: `Deploy failed for ${site.primaryDomain} (${deployRes.error?.code ?? "DEPLOY_FAILED"})`,
        });
        return agentErrorResponse(reply, deployRes);
      }

      const updated = db.select().from(sites).where(eq(sites.id, siteId)).get();
      return reply.send(updated ? withoutSecrets(updated) : updated);
    },
  );

  app.patch(
    "/api/sites/:id/mode",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const siteId = Number(id);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const body = request.body as {
        mode: string;
        noticeTitle?: string;
        noticeMessage?: string;
        noticeEta?: string;
      };

      if (!body.mode) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "mode is required" },
        });
      }

      const validModes = ["online", "maintenance", "disabled"];
      if (!validModes.includes(body.mode)) {
        return reply.status(400).send({
          error: {
            code: "INVALID_BODY",
            message: "mode must be online, maintenance or disabled",
          },
        });
      }

      for (const [field, max] of [["noticeTitle", 200], ["noticeMessage", 2000], ["noticeEta", 100]] as const) {
        const v = body[field];
        if (v !== undefined && v !== null && !isDisplayText(v, max)) {
          return reply.status(400).send({
            error: { code: "INVALID_BODY", message: `${field} must be text of at most ${max} characters` },
          });
        }
      }

      const db = getDB();

      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      if (request.session!.user.role !== "admin" && (body.mode === "disabled" || site.mode === "disabled")) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Only admins can disable or re-enable sites" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, site.accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const oldMode = site.mode;

      if (oldMode !== body.mode && (body.mode === "disabled" || oldMode === "disabled")) {
        const modeRes = await agent.callAction("site.set_mode", {
          account_slug: account.slug,
          domain: site.primaryDomain,
          mode: body.mode,
        });
        if (!modeRes.ok) {
          logAudit({
            actorUserId: request.session!.user.id,
            actorKind: "user",
            action: "site.set_mode",
            targetType: "site",
            targetId: String(site.id),
            result: "error",
            errorCode: modeRes.error?.code ?? "AGENT_ERROR",
          });
          return agentErrorResponse(reply, modeRes);
        }
      }

      db.update(sites)
        .set({
          mode: body.mode as "online" | "maintenance" | "disabled",
          noticeTitle: body.noticeTitle ?? null,
          noticeMessage: body.noticeMessage ?? null,
          noticeEta: body.noticeEta ?? null,
        })
        .where(eq(sites.id, siteId))
        .run();

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
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "site.set_mode",
        targetType: "site",
        targetId: String(site.id),
        result: "ok",
      });

      const updated = db.select().from(sites).where(eq(sites.id, siteId)).get();
      return reply.send(updated ? withoutSecrets(updated) : updated);
    },
  );
}

export { getLatestCommit, buildCaddySyncPayload };
