import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_LEN = 12;
const TAG_LEN = 16;

let _testKey: Buffer | null = null;

export function setSecretKeyForTest(key: Buffer): void {
  _testKey = key;
}

export function clearSecretKey(): void {
  _testKey = null;
}

export function getSecretKey(): Buffer {
  if (_testKey) return _testKey;
  const hex = process.env.FORJA_SECRET_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "FORJA_SECRET_KEY must be a 64-char hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}

export function encryptSecret(plaintext: string): string {
  const key = getSecretKey();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = getSecretKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < NONCE_LEN + TAG_LEN) {
    throw new Error("invalid ciphertext: too short");
  }
  const nonce = buf.subarray(0, NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}
