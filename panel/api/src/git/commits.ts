import { eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { gitIntegrations, sites } from "../db/schema.js";
import { decryptSecret } from "../crypto/secrets.js";

/** Credentials of the Git integration a site was created from, if any. */
export interface GitApiAuth {
  baseUrl: string;
  token: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

async function fetchJSON(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Git API returned ${res.status}`);
  }
  return res.json();
}

function checkedSha(sha: unknown): string {
  if (typeof sha !== "string" || !COMMIT_SHA_RE.test(sha)) {
    throw new Error("Git API returned an invalid commit id");
  }
  return sha;
}

/** Splits an https repo URL into origin and `owner`/`repo` (without `.git`). */
function parseRepoURL(repo: string): { origin: string; owner: string; name: string } {
  const match = repo.match(/^(https:\/\/[^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("invalid repo URL");
  return { origin: match[1], owner: match[2], name: match[3] };
}

/**
 * Latest commit of a branch. GitHub repos use the public GitHub API; any other
 * host is a Gitea instance and needs the integration it was created from, so
 * the token is only ever sent to that integration's own base URL.
 */
export async function getLatestCommit(
  repo: string,
  branch: string,
  auth?: GitApiAuth | null,
): Promise<string> {
  const { origin, owner, name } = parseRepoURL(repo);
  const branchPath = branch.split("/").map(encodeURIComponent).join("/");

  if (origin === "https://github.com") {
    const data = (await fetchJSON(
      `https://api.github.com/repos/${owner}/${name}/commits/${branchPath}`,
      { Accept: "application/vnd.github.v3+json" },
    )) as { sha?: unknown };
    return checkedSha(data.sha);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth && auth.baseUrl === origin) {
    headers.Authorization = `token ${auth.token}`;
  }
  const data = (await fetchJSON(
    `${origin}/api/v1/repos/${owner}/${name}/branches/${branchPath}`,
    headers,
  )) as { commit?: { id?: unknown } };
  return checkedSha(data.commit?.id);
}

/** Latest commit for a stored site, using its Git integration when it has one. */
export async function getSiteLatestCommit(
  site: Pick<typeof sites.$inferSelect, "repo" | "branch" | "gitIntegrationId">,
): Promise<string> {
  let auth: GitApiAuth | null = null;
  if (site.gitIntegrationId) {
    const integration = getDB()
      .select()
      .from(gitIntegrations)
      .where(eq(gitIntegrations.id, site.gitIntegrationId))
      .get();
    if (integration?.baseUrl) {
      auth = {
        baseUrl: integration.baseUrl,
        token: decryptSecret(integration.credentialsEnc),
      };
    }
  }
  return getLatestCommit(site.repo!, site.branch!, auth);
}
