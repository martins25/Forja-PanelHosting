import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  setSecretKeyForTest,
  clearSecretKey,
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
} from "./secrets.js";

describe("secrets crypto", () => {
  const testKey = randomBytes(32);

  beforeEach(() => {
    setSecretKeyForTest(testKey);
  });

  afterEach(() => {
    clearSecretKey();
  });

  it("roundtrip encrypt/decrypt", () => {
    const original = "my-super-secret-webhook-key";
    const encrypted = encryptSecret(original);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(original);
  });

  it("produces different ciphertexts for the same plaintext", () => {
    const plaintext = "same-input";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("throws on tampered ciphertext", () => {
    const encrypted = encryptSecret("secret");
    const buf = Buffer.from(encrypted, "base64");
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws with wrong key", () => {
    const encrypted = encryptSecret("secret");
    setSecretKeyForTest(randomBytes(32));
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it("throws on too-short ciphertext", () => {
    expect(() => decryptSecret("dG9vc2hvcnQ=")).toThrow("too short");
  });

  it("generateWebhookSecret returns 64-char hex", () => {
    const secret = generateWebhookSecret();
    expect(secret).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(secret)).toBe(true);
  });
});
