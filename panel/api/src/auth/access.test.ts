import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  configureAccess,
  resetAccess,
  verifyAccessJWT,
  setVerifierForTest,
  clearVerifierForTest,
} from "./access.js";

describe("access", () => {
  beforeAll(() => {
    configureAccess({
      teamDomain: "test.cloudflareaccess.com",
      audience: "test-audience-id",
    });
  });

  afterAll(() => {
    clearVerifierForTest();
    resetAccess();
  });

  describe("verifyAccessJWT", () => {
    it("extracts email from a valid JWT", async () => {
      setVerifierForTest(async (token, audience) => {
        expect(audience).toBe("test-audience-id");
        return {
          email: "admin@forja.dev",
          sub: "user-123",
          aud: [audience],
          iss: "https://test.cloudflareaccess.com",
        };
      });

      const claims = await verifyAccessJWT("fake-jwt-token");
      expect(claims.email).toBe("admin@forja.dev");
      expect(claims.sub).toBe("user-123");
    });

    it("uses email as sub fallback", async () => {
      setVerifierForTest(async () => ({
        email: "admin@forja.dev",
      }));

      const claims = await verifyAccessJWT("fake-jwt-token");
      expect(claims.sub).toBe("admin@forja.dev");
    });

    it("rejects JWT without email", async () => {
      setVerifierForTest(async () => ({
        sub: "user-456",
      }));

      await expect(verifyAccessJWT("fake-jwt-token")).rejects.toThrow(
        "JWT missing email claim",
      );
    });

    it("throws when Access is not configured", async () => {
      clearVerifierForTest();
      resetAccess();
      await expect(verifyAccessJWT("token")).rejects.toThrow(
        "Cloudflare Access not configured",
      );
      configureAccess({
        teamDomain: "test.cloudflareaccess.com",
        audience: "test-audience-id",
      });
    });
  });
});
