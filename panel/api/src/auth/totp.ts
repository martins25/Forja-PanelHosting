import { TOTP, Secret } from "otpauth";
import { randomBytes } from "node:crypto";
import { encryptString, decryptString } from "./crypto.js";

const ISSUER = "Forja";
const PERIOD = 30;
const DIGITS = 6;
const ALGORITHM = "SHA1";

export function generateSecret(): string {
  const bytes = randomBytes(20);
  return new Secret({ buffer: bytes.buffer }).base32;
}

export function generateURI(email: string, secret: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    secret,
    period: PERIOD,
    digits: DIGITS,
    algorithm: ALGORITHM,
  });
  return totp.toString();
}

export function verifyCode(secret: string, code: string): boolean {
  const totp = new TOTP({
    secret,
    period: PERIOD,
    digits: DIGITS,
    algorithm: ALGORITHM,
  });
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

export function encryptSecret(secret: string): string {
  return encryptString(secret);
}

export function decryptSecret(encrypted: string): string {
  return decryptString(encrypted);
}
