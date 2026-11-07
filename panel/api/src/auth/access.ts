import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

export interface AccessClaims {
  email: string;
  sub: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedConfig: AccessConfig | null = null;

export function configureAccess(config: AccessConfig): void {
  const certsUrl = new URL(
    `/cdn-cgi/access/certs`,
    `https://${config.teamDomain}`,
  );
  jwks = createRemoteJWKSet(certsUrl);
  cachedConfig = config;
}

export function resetAccess(): void {
  jwks = null;
  cachedConfig = null;
}

export type JWKSVerifier = (
  token: string,
  audience: string,
) => Promise<JWTPayload>;

let verifierOverride: JWKSVerifier | null = null;

export function setVerifierForTest(fn: JWKSVerifier): void {
  verifierOverride = fn;
}

export function clearVerifierForTest(): void {
  verifierOverride = null;
}

export async function verifyAccessJWT(token: string): Promise<AccessClaims> {
  if (!cachedConfig) {
    throw new Error("Cloudflare Access not configured — call configureAccess()");
  }

  let payload: JWTPayload;

  if (verifierOverride) {
    payload = await verifierOverride(token, cachedConfig.audience);
  } else {
    if (!jwks) {
      throw new Error("JWKS not initialized");
    }
    const result = await jwtVerify(token, jwks, {
      audience: cachedConfig.audience,
      algorithms: ["RS256"],
    });
    payload = result.payload;
  }

  const email = payload.email as string | undefined;
  const sub = payload.sub as string | undefined;

  if (!email || typeof email !== "string") {
    throw new Error("JWT missing email claim");
  }

  return { email, sub: sub ?? email };
}
