// First-layer input validation (whitelists). The agent repeats every one of
// these checks (agent/internal/validate) because it never trusts the API; this
// module exists so hostile values are refused before they reach the database,
// the agent or an outgoing request. Keep both sides in sync.

const SLUG_RE = /^[a-z][a-z0-9-]{2,30}$/;
const DB_IDENT_RE = /^[a-z][a-z0-9_]{2,40}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;
const CONTAINER_CMD_RE = /^[a-zA-Z0-9 _./:=@-]{1,200}$/;
const PUBLIC_DIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/;
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/;
const GITHUB_REPO_RE = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"'`$|&*{}]+@[^\s@<>()[\]\\,;:"'`$|&*{}]+\.[^\s@<>()[\]\\,;:"'`$|&*{}]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f]/;

const MAX_PATH_LENGTH = 1024;
const MAX_EMAIL_LENGTH = 254;

export const MAX_ENV_VALUE_LENGTH = 8192;

export function isSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG_RE.test(value);
}

export function isHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (value !== value.toLowerCase()) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

export function isDbIdentifier(value: unknown): value is string {
  return typeof value === "string" && DB_IDENT_RE.test(value);
}

export function isBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    BRANCH_RE.test(value) &&
    !value.startsWith("-") &&
    !value.includes("..")
  );
}

export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_RE.test(value);
}

/** https://github.com/<owner>/<repo>[.git], the only host the API talks to for "github" sites. */
export function isGithubRepoUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = GITHUB_REPO_RE.exec(value);
  if (!m) return false;
  return m[1] !== "." && m[1] !== ".." && m[2] !== "." && m[2] !== "..";
}

/** Install, build and start commands run inside the container, never on the host. */
export function isContainerCmd(value: unknown): value is string {
  return typeof value === "string" && (value === "" || CONTAINER_CMD_RE.test(value));
}

export function isPublicDir(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "") return true;
  return PUBLIC_DIR_RE.test(value) && !value.includes("..");
}

export function isRuntimeVersion(runtime: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  switch (runtime) {
    case "node":
      return /^(18|20|22|24)$/.test(value);
    case "php":
      return /^(8\.1|8\.2|8\.3|8\.4)$/.test(value);
    case "python":
      return /^(3\.11|3\.12|3\.13)$/.test(value);
    default:
      return value === "";
  }
}

function hasTraversalSegment(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => seg === "..");
}

/**
 * A path inside an account home, as sent by the file manager. Returns the path
 * to forward to the agent, or null when it must be refused. Only relative
 * paths are accepted ("/" is the home itself); `..` segments, NUL and other
 * control characters never are.
 */
export function accountPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value === "/") return ".";
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null;
  if (CONTROL_CHARS_RE.test(value)) return null;
  if (value.startsWith("/")) return null;
  if (hasTraversalSegment(value)) return null;
  return value;
}

/** Stored build-log path: absolute (as returned by the agent) or relative, never with `..`. */
export function isBuildLogPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !CONTROL_CHARS_RE.test(value) &&
    !hasTraversalSegment(value)
  );
}

/** Env values are written to a KEY=VALUE file: no line breaks, no NUL. */
export function isEnvValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_ENV_VALUE_LENGTH &&
    !/[\0\r\n]/.test(value)
  );
}

export function isEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_EMAIL_LENGTH &&
    EMAIL_RE.test(value)
  );
}

/** Free text shown to people (site notices, reasons): bounded, no control characters but \n and \t. */
export function isDisplayText(value: unknown, maxLength: number): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length <= maxLength && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
