import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  setAppKeyForTest,
  clearAppKey,
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  hashPassword,
  verifyPassword,
  getAppKey,
} from "./crypto.js";

const TEST_KEY = randomBytes(32);

describe("crypto", () => {
  beforeAll(() => setAppKeyForTest(TEST_KEY));
  afterAll(() => clearAppKey());

  describe("encrypt / decrypt", () => {
    it("round-trips binary data", () => {
      const plain = Buffer.from("hello forja");
      const cipher = encrypt(plain);
      const result = decrypt(cipher);
      expect(result.equals(plain)).toBe(true);
    });

    it("round-trips empty data", () => {
      const plain = Buffer.alloc(0);
      const result = decrypt(encrypt(plain));
      expect(result.equals(plain)).toBe(true);
    });

    it("produces different ciphertexts for the same plaintext (random nonce)", () => {
      const plain = Buffer.from("test");
      const a = encrypt(plain);
      const b = encrypt(plain);
      expect(a.equals(b)).toBe(false);
    });

    it("rejects tampered ciphertext", () => {
      const cipher = encrypt(Buffer.from("secret"));
      cipher[cipher.length - 1] ^= 0xff;
      expect(() => decrypt(cipher)).toThrow();
    });

    it("rejects too-short ciphertext", () => {
      expect(() => decrypt(Buffer.alloc(10))).toThrow("ciphertext too short");
    });
  });

  describe("encryptString / decryptString", () => {
    it("round-trips a UTF-8 string via base64", () => {
      const text = "contraseña con ñ y 🔑";
      const enc = encryptString(text);
      expect(typeof enc).toBe("string");
      expect(decryptString(enc)).toBe(text);
    });
  });

  describe("getAppKey", () => {
    it("throws when key is not loaded", () => {
      clearAppKey();
      expect(() => getAppKey()).toThrow("app key not loaded");
      setAppKeyForTest(TEST_KEY);
    });
  });

  describe("setAppKeyForTest", () => {
    it("rejects keys of wrong length", () => {
      expect(() => setAppKeyForTest(Buffer.alloc(16))).toThrow(
        "test key must be exactly 32 bytes",
      );
    });
  });

  describe("argon2id", () => {
    it("hashes and verifies a password", async () => {
      const hash = await hashPassword("s3cret!");
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(hash, "s3cret!")).toBe(true);
    });

    it("rejects a wrong password", async () => {
      const hash = await hashPassword("correct");
      expect(await verifyPassword(hash, "wrong")).toBe(false);
    });

    it("produces different hashes for the same password (random salt)", async () => {
      const a = await hashPassword("same");
      const b = await hashPassword("same");
      expect(a).not.toBe(b);
    });
  });
});
