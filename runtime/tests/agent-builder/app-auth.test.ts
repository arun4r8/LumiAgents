import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../../src/types";
import {
  buildJwtClaims,
  mintAppJwt,
  requireAppSecrets,
  hasAppSecrets,
  getInstallationToken,
  _resetInstallationTokenCache,
} from "../../src/integrations/github/app-auth";

// Tier 2 (#67): the GitHub App JWT construction. We test the claim set and the full RS256 mint
// against a locally-generated key (no network) — the installation-token exchange is exercised
// with an injected fake fetch. No real GitHub call.

function decodeSeg(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(seg.length + ((4 - (seg.length % 4)) % 4), "=");
  return JSON.parse(atob(b64)) as Record<string, unknown>;
}

async function makeBase64Pkcs8Pem(): Promise<string> {
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = (btoa(bin).match(/.{1,64}/g) ?? []).join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
  return btoa(pem); // GH_APP_PRIVATE_KEY is the base64 of a PKCS8 PEM
}

function envWith(overrides: Partial<Env>): Env {
  return {
    GH_APP_ID: "123456",
    GH_APP_INSTALLATION_ID: "789",
    ...overrides,
  } as unknown as Env;
}

describe("GitHub App JWT claims", () => {
  it("sets iss to the app id, backdates iat, and keeps the lifetime under 10 minutes", () => {
    const now = 1_700_000_000;
    const claims = buildJwtClaims("app-42", now);
    expect(claims.iss).toBe("app-42");
    expect(claims.iat).toBeLessThan(now); // backdated for clock drift
    expect(claims.exp).toBeGreaterThan(now);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600); // GitHub's hard cap
  });
});

describe("requireAppSecrets / hasAppSecrets", () => {
  it("throws naming every missing secret", () => {
    expect(() => requireAppSecrets(envWith({ GH_APP_ID: undefined, GH_APP_INSTALLATION_ID: undefined, GH_APP_PRIVATE_KEY: undefined })))
      .toThrow(/GH_APP_ID.*GH_APP_INSTALLATION_ID.*GH_APP_PRIVATE_KEY/);
  });
  it("does not throw when all three are present", () => {
    expect(hasAppSecrets(envWith({ GH_APP_PRIVATE_KEY: "x" }))).toBe(true);
    expect(() => requireAppSecrets(envWith({ GH_APP_PRIVATE_KEY: "x" }))).not.toThrow();
  });
  it("reports absence without throwing", () => {
    expect(hasAppSecrets(envWith({ GH_APP_PRIVATE_KEY: undefined }))).toBe(false);
  });
});

describe("mintAppJwt", () => {
  it("produces a 3-segment RS256 JWT with the expected header and claims", async () => {
    const env = envWith({ GH_APP_ID: "555", GH_APP_PRIVATE_KEY: await makeBase64Pkcs8Pem() });
    const now = 1_700_000_000;
    const jwt = await mintAppJwt(env, now);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    expect(decodeSeg(parts[0] as string)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const payload = decodeSeg(parts[1] as string);
    expect(payload["iss"]).toBe("555");
    expect(payload["exp"]).toBe(now + 480);
    expect((parts[2] as string).length).toBeGreaterThan(0); // real signature
  });

  it("throws when the private key is missing", async () => {
    await expect(mintAppJwt(envWith({ GH_APP_PRIVATE_KEY: undefined }), 1)).rejects.toThrow(/GH_APP_PRIVATE_KEY/);
  });
});

describe("getInstallationToken", () => {
  beforeEach(() => _resetInstallationTokenCache());

  it("mints a JWT, exchanges it for an installation token, and caches it", async () => {
    const env = envWith({ GH_APP_ID: "1", GH_APP_PRIVATE_KEY: await makeBase64Pkcs8Pem() });
    let calls = 0;
    const seenAuth: string[] = [];
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const auth = (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? "";
      seenAuth.push(auth);
      return new Response(JSON.stringify({ token: "ghs_installtoken", expires_at: "2999-01-01T00:00:00Z" }), { status: 200 });
    }) as unknown as typeof fetch;

    const t1 = await getInstallationToken(env, { fetch: fakeFetch, now: () => 1_700_000_000_000 });
    const t2 = await getInstallationToken(env, { fetch: fakeFetch, now: () => 1_700_000_000_000 });
    expect(t1).toBe("ghs_installtoken");
    expect(t2).toBe("ghs_installtoken");
    expect(calls).toBe(1); // second call served from cache
    expect(seenAuth[0]).toMatch(/^Bearer .+\..+\..+$/); // exchanged the App JWT
  });

  it("throws a clear error when the exchange fails", async () => {
    const env = envWith({ GH_APP_ID: "1", GH_APP_PRIVATE_KEY: await makeBase64Pkcs8Pem() });
    const fakeFetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(getInstallationToken(env, { fetch: fakeFetch, now: () => 1_700_000_000_000 }))
      .rejects.toThrow(/installation-token mint failed → 401/);
  });
});
