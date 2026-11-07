import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import {
  generateSecret,
  generateURI,
  verifyCode,
  encryptSecret,
  decryptSecret,
} from "./totp.js";
import { setAppKeyForTest, clearAppKey } from "./crypto.js";

describe("totp", () => {
  beforeAll(() => setAppKeyForTest(randomBytes(32)));
  afterAll(() => clearAppKey());

  describe("generateSecret", () => {
    it("returns a valid base32 string", () => {
      const secret = generateSecret();
      expect(secret).toMatch(/^[A-Z2-7]+=*$/);
      const parsed = Secret.fromBase32(secret);
      expect(parsed.bytes.length).toBe(20);
    });

    it("generates unique secrets", () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a).not.toBe(b);
    });
  });

  describe("generateURI", () => {
    it("returns an otpauth:// URI with issuer and label", () => {
      const secret = generateSecret();
      const uri = generateURI("admin@forja.dev", secret);
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain("issuer=Forja");
      expect(uri).toContain("admin%40forja.dev");
    });
  });

  describe("verifyCode", () => {
    it("accepts a valid current code", () => {
      const secret = generateSecret();
      const totp = new TOTP({ secret, period: 30, digits: 6, algorithm: "SHA1" });
      const code = totp.generate();
      expect(verifyCode(secret, code)).toBe(true);
    });

    it("rejects an invalid code", () => {
      const secret = generateSecret();
      expect(verifyCode(secret, "000000")).toBe(false);
    });
  });

  describe("encryptSecret / decryptSecret", () => {
    it("round-trips through encryption", () => {
      const secret = generateSecret();
      const encrypted = encryptSecret(secret);
      expect(encrypted).not.toBe(secret);
      expect(decryptSecret(encrypted)).toBe(secret);
    });
  });
});
