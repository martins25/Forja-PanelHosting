import { readFileSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import argon2 from "argon2";

const APP_KEY_PATH = process.env.FORJA_APP_KEY ?? "/etc/forja/app.key";
const KEY_LENGTH = 32;

let appKey: Buffer | null = null;

export function loadAppKey(path?: string): Buffer {
  const keyPath = path ?? APP_KEY_PATH;
  const raw = readFileSync(keyPath);
  if (raw.length !== KEY_LENGTH) {
    throw new Error(`app.key must be exactly ${KEY_LENGTH} bytes`);
  }
  appKey = raw;
  return appKey;
}

export function getAppKey(): Buffer {
  if (!appKey) {
    throw new Error("app key not loaded — call loadAppKey() first");
  }
  return appKey;
}

export function setAppKeyForTest(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`test key must be exactly ${KEY_LENGTH} bytes`);
  }
  appKey = key;
}

export function clearAppKey(): void {
  appKey = null;
}

const ALGO = "chacha20-poly1305" as const;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plaintext: Buffer): Buffer {
  const key = getAppKey();
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGO, key, nonce, { authTagLength: TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, encrypted]);
}

export function decrypt(ciphertext: Buffer): Buffer {
  const key = getAppKey();
  if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error("ciphertext too short");
  }
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const tag = ciphertext.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH);
  const data = ciphertext.subarray(NONCE_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, key, nonce, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export function encryptString(plaintext: string): string {
  return encrypt(Buffer.from(plaintext, "utf8")).toString("base64");
}

export function decryptString(encoded: string): string {
  return decrypt(Buffer.from(encoded, "base64")).toString("utf8");
}

const ARGON2_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  return argon2.verify(hash, password);
}

const TOTP_TOKEN_TTL_MS = 5 * 60 * 1000;
const TOTP_TOKEN_PURPOSE = "totp-login";

function hmacSign(data: string): Buffer {
  return createHmac("sha256", getAppKey()).update(data).digest();
}

/**
 * Issue a short-lived token proving the password step was completed for
 * `userId` by the requester identified by `email` (Cloudflare Access claim).
 * Format: base64url(payload) "." base64url(HMAC-SHA256(payload)).
 */
export function signTotpToken(userId: number, email: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ p: TOTP_TOKEN_PURPOSE, userId, email, ts: now }),
  ).toString("base64url");
  return `${payload}.${hmacSign(payload).toString("base64url")}`;
}

export type TotpTokenResult =
  | { ok: true; userId: number }
  | { ok: false; reason: "invalid" | "expired" };

/** Verify signature (constant time), purpose, requester binding and expiry. */
export function verifyTotpToken(token: unknown, email: string, now = Date.now()): TotpTokenResult {
  if (typeof token !== "string") return { ok: false, reason: "invalid" };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "invalid" };
  const [payload, sig] = parts as [string, string];

  const expected = hmacSign(payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "invalid" };
  }

  let parsed: { p?: unknown; userId?: unknown; email?: unknown; ts?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (
    parsed.p !== TOTP_TOKEN_PURPOSE ||
    typeof parsed.userId !== "number" ||
    typeof parsed.email !== "string" ||
    typeof parsed.ts !== "number"
  ) {
    return { ok: false, reason: "invalid" };
  }

  const a = Buffer.from(parsed.email);
  const b = Buffer.from(email);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "invalid" };
  }

  if (now - parsed.ts > TOTP_TOKEN_TTL_MS || parsed.ts > now + 1000) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, userId: parsed.userId };
}

export { timingSafeEqual };
