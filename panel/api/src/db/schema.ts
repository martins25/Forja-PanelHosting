import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  role: text("role", { enum: ["admin", "client"] }).notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnc: text("totp_secret_enc"),
  webauthnCredentials: text("webauthn_credentials"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  lastLoginAt: text("last_login_at"),
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
});

export const userAccounts = sqliteTable(
  "user_accounts",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
  },
  (table) => [primaryKey({ columns: [table.userId, table.accountId] })],
);

export const plans = sqliteTable("plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  cpuMillis: integer("cpu_millis").notNull(),
  memoryMb: integer("memory_mb").notNull(),
  diskMb: integer("disk_mb").notNull(),
  maxSites: integer("max_sites").notNull(),
  maxDatabases: integer("max_databases").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull().unique(),
    linuxUser: text("linux_user").notNull(),
    uid: integer("uid").notNull(),
    planId: integer("plan_id").references(() => plans.id),
    cfConnectionId: integer("cf_connection_id").references(
      () => cfConnections.id,
    ),
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  },
  (t) => [
    // One account per Cloudflare connection (NULLs are distinct in SQLite).
    uniqueIndex("accounts_cf_connection_unique").on(t.cfConnectionId),
  ],
);

export const sites = sqliteTable("sites", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  primaryDomain: text("primary_domain").notNull(),
  runtime: text("runtime", {
    enum: ["node", "php", "python", "static", "docker"],
  }).notNull(),
  runtimeVersion: text("runtime_version"),
  source: text("source", {
    enum: ["github", "gitea", "upload", "template"],
  }),
  repo: text("repo"),
  gitIntegrationId: integer("git_integration_id").references(
    () => gitIntegrations.id,
  ),
  branch: text("branch"),
  installCmd: text("install_cmd"),
  buildCmd: text("build_cmd"),
  startCmd: text("start_cmd"),
  internalPort: integer("internal_port"),
  publicDir: text("public_dir"),
  mode: text("mode", { enum: ["online", "maintenance", "disabled"] })
    .notNull()
    .default("online"),
  noticeTitle: text("notice_title"),
  noticeMessage: text("notice_message"),
  noticeEta: text("notice_eta"),
  autodeploy: integer("autodeploy", { mode: "boolean" })
    .notNull()
    .default(true),
  webhookSecretEnc: text("webhook_secret_enc"),
  statsEnabled: integer("stats_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const domains = sqliteTable("domains", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sites.id),
  hostname: text("hostname").notNull(),
  kind: text("kind", { enum: ["primary", "alias", "redirect"] })
    .notNull()
    .default("primary"),
  cert: text("cert", { enum: ["cloudflare", "letsencrypt"] })
    .notNull()
    .default("cloudflare"),
  certExpiresAt: text("cert_expires_at"),
});

export const deployments = sqliteTable("deployments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sites.id),
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  trigger: text("trigger", {
    enum: ["webhook", "manual", "rollback"],
  }).notNull(),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "failed"],
  })
    .notNull()
    .default("queued"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  logPath: text("log_path"),
});

export const envVars = sqliteTable("env_vars", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sites.id),
  key: text("key").notNull(),
  valueEnc: text("value_enc").notNull(),
});

export const databases = sqliteTable("databases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  engine: text("engine", {
    enum: ["mariadb", "mysql", "postgres"],
  }).notNull(),
  name: text("name").notNull(),
  dbUser: text("db_user").notNull(),
  passwordEnc: text("password_enc").notNull(),
  // Engine superuser password (encrypted). Only set on the row whose creation
  // started the engine container; never exposed by the API.
  rootPasswordEnc: text("root_password_enc"),
  webTool: text("web_tool", {
    enum: ["phpmyadmin", "adminer", "pgadmin", "none"],
  })
    .notNull()
    .default("none"),
});

export const cfConnections = sqliteTable("cf_connections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  ownerUserId: integer("owner_user_id").references(() => users.id),
  cfAccountId: text("cf_account_id").notNull(),
  apiTokenEnc: text("api_token_enc").notNull(),
  tunnelId: text("tunnel_id"),
  tunnelTokenEnc: text("tunnel_token_enc"),
  // Account that ever received the tunnel token (the one running cloudflared).
  // Not a FK: accounts already references this table. It never changes once set.
  hostAccountId: integer("host_account_id"),
  managedBy: text("managed_by", { enum: ["admin", "client"] })
    .notNull()
    .default("admin"),
  status: text("status").notNull().default("active"),
});

export const gitIntegrations = sqliteTable("git_integrations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider", { enum: ["github", "gitea"] }).notNull(),
  baseUrl: text("base_url"),
  ownerUserId: integer("owner_user_id").references(() => users.id),
  credentialsEnc: text("credentials_enc").notNull(),
  webhookSecretEnc: text("webhook_secret_enc").notNull(),
});

export const backups = sqliteTable("backups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  siteId: integer("site_id").references(() => sites.id),
  kind: text("kind", { enum: ["snapshot", "export"] }).notNull(),
  resticSnapshotId: text("restic_snapshot_id"),
  sizeBytes: integer("size_bytes"),
  includes: text("includes"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  status: text("status").notNull().default("pending"),
});

// Optional S3-compatible destinations the local restic repos are copied to.
export const backupRemotes = sqliteTable("backup_remotes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["s3", "r2"] }).notNull(),
  endpoint: text("endpoint").notNull(),
  bucket: text("bucket").notNull(),
  region: text("region").notNull(),
  accessKeyEnc: text("access_key_enc").notNull(),
  secretKeyEnc: text("secret_key_enc").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

export const statsDaily = sqliteTable(
  "stats_daily",
  {
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id),
    day: text("day").notNull(),
    path: text("path").notNull(),
    country: text("country").notNull().default(""),
    referrerHost: text("referrer_host").notNull().default(""),
    device: text("device").notNull().default(""),
    browser: text("browser").notNull().default(""),
    views: integer("views").notNull().default(0),
    visits: integer("visits").notNull().default(0),
    uniques: integer("uniques").notNull().default(0),
    status2xx: integer("status_2xx").notNull().default(0),
    status4xx: integer("status_4xx").notNull().default(0),
    status5xx: integer("status_5xx").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.siteId,
        table.day,
        table.path,
        table.country,
        table.referrerHost,
        table.device,
        table.browser,
      ],
    }),
  ],
);

// Daily per-site aggregates built from Caddy access logs. No IPs or hashes are stored.
export const siteStats = sqliteTable(
  "site_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id),
    date: text("date").notNull(),
    pageviews: integer("pageviews").notNull().default(0),
    uniqueVisitors: integer("unique_visitors").notNull().default(0),
    topPaths: text("top_paths").notNull().default("[]"),
    topReferrers: text("top_referrers").notNull().default("[]"),
    topCountries: text("top_countries").notNull().default("[]"),
  },
  (t) => [uniqueIndex("site_stats_site_date_unique").on(t.siteId, t.date)],
);

// One Let's Encrypt certificate per site (DNS-01 through the account's Cloudflare token).
export const certificates = sqliteTable(
  "certificates",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siteId: integer("site_id")
      .notNull()
      .references(() => sites.id),
    domain: text("domain").notNull(),
    provider: text("provider", { enum: ["letsencrypt"] })
      .notNull()
      .default("letsencrypt"),
    status: text("status", { enum: ["pending", "active", "expired", "error"] })
      .notNull()
      .default("pending"),
    issuedAt: text("issued_at"),
    expiresAt: text("expires_at"),
    autoRenew: integer("auto_renew", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("certificates_site_unique").on(t.siteId)],
);

export const removalRequests = sqliteTable("removal_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: integer("site_id")
    .notNull()
    .references(() => sites.id),
  requestedBy: integer("requested_by")
    .notNull()
    .references(() => users.id),
  reason: text("reason"),
  status: text("status", { enum: ["open", "done", "rejected"] })
    .notNull()
    .default("open"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
});

export const auditLog = sqliteTable("audit_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: text("at").notNull().default("CURRENT_TIMESTAMP"),
  actorUserId: integer("actor_user_id"),
  actorKind: text("actor_kind", {
    enum: ["user", "system", "webhook"],
  }).notNull(),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: text("target_id"),
  paramsRedacted: text("params_redacted"),
  result: text("result", { enum: ["ok", "error"] }).notNull(),
  errorCode: text("error_code"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  csrfToken: text("csrf_token").notNull(),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
  expiresAt: text("expires_at").notNull(),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
});

export const invitations = sqliteTable("invitations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull(),
  role: text("role", { enum: ["admin", "client"] }).notNull(),
  token: text("token").notNull().unique(),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  expiresAt: text("expires_at").notNull(),
  acceptedAt: text("accepted_at"),
  createdAt: text("created_at").notNull().default("CURRENT_TIMESTAMP"),
});

export const invitationAccounts = sqliteTable(
  "invitation_accounts",
  {
    invitationId: integer("invitation_id")
      .notNull()
      .references(() => invitations.id),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
  },
  (table) => [primaryKey({ columns: [table.invitationId, table.accountId] })],
);

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  provider: text("provider").notNull(),
  deliveryId: text("delivery_id").notNull(),
  siteId: integer("site_id").references(() => sites.id),
  receivedAt: text("received_at").notNull().default("CURRENT_TIMESTAMP"),
  signatureOk: integer("signature_ok", { mode: "boolean" }).notNull(),
  processed: integer("processed", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const ALERT_EVENTS = [
  "site_down",
  "deploy_failed",
  "disk_high",
  "ram_high",
  "backup_failed",
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

// Notification destinations owned by a user. Only "email" for now.
export const alertChannels = sqliteTable("alert_channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind", { enum: ["email"] }).notNull(),
  config: text("config").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

export const alertRules = sqliteTable("alert_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  event: text("event", { enum: ALERT_EVENTS }).notNull(),
  channelId: integer("channel_id")
    .notNull()
    .references(() => alertChannels.id),
  threshold: text("threshold"),
});

export const alertLog = sqliteTable("alert_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  channelId: integer("channel_id")
    .notNull()
    .references(() => alertChannels.id),
  event: text("event", { enum: ALERT_EVENTS }).notNull(),
  message: text("message").notNull(),
  sentAt: text("sent_at").notNull(),
  status: text("status", { enum: ["queued", "sent", "failed"] }).notNull(),
});
