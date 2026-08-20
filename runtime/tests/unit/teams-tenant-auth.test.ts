import { describe, it, expect, vi } from "vitest";
import { trustFor, getBotToken } from "../../../integrations/teams/base";

/**
 * SingleTenant bot authentication.
 *
 * Azure deprecated MultiTenant bot creation, so the registration is SingleTenant
 * and three things move together: the token authority, the issuer that signs
 * inbound activities, and where the signing keys are published. Getting any one
 * of them wrong produces a 401 on every request, which is indistinguishable from
 * the bot simply never being reached. That failure mode is why these assertions
 * are worth having: the symptom carries no information.
 */

const TENANT = "d0f4c9a1-3b77-4e21-9c8e-11aa22bb33cc";

describe("trustFor", () => {
  it("keeps the legacy multi-tenant path unchanged when no tenant is set", () => {
    const t = trustFor();
    expect(t.oidc).toBe("https://login.botframework.com/v1/.well-known/openidconfiguration");
    expect(t.issuers.has("https://api.botframework.com")).toBe(true);
  });

  it("points at the tenant's own OIDC document when a tenant is set", () => {
    expect(trustFor(TENANT).oidc).toBe(
      `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
    );
  });

  it("accepts both issuer forms, because v1 and v2 tokens differ", () => {
    const { issuers } = trustFor(TENANT);
    expect(issuers.has(`https://login.microsoftonline.com/${TENANT}/v2.0`)).toBe(true);
    expect(issuers.has(`https://sts.windows.net/${TENANT}/`)).toBe(true);
  });

  // The two that encode the actual bug. Before this change the issuer set was a
  // module constant, so a SingleTenant bot's activities were checked against Bot
  // Framework's issuers and rejected every time.
  it("rejects a Bot Framework issuer once a tenant is configured", () => {
    const { issuers } = trustFor(TENANT);
    expect(issuers.has("https://api.botframework.com")).toBe(false);
    expect(issuers.has("https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/")).toBe(false);
  });

  it("rejects a tenant issuer when no tenant is configured", () => {
    const { issuers } = trustFor();
    expect(issuers.has(`https://login.microsoftonline.com/${TENANT}/v2.0`)).toBe(false);
  });

  it("never shares an issuer between the two modes", () => {
    const a = [...trustFor().issuers];
    const b = trustFor(TENANT).issuers;
    expect(a.filter((i) => b.has(i))).toEqual([]);
  });
});

describe("getBotToken authority", () => {
  function fakeFetch(): { calls: string[]; impl: typeof fetch } {
    const calls: string[] = [];
    const impl = vi.fn(async (url: unknown) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ access_token: "t" }) };
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("mints against the tenant authority when a tenant is set", async () => {
    const { calls, impl } = fakeFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await getBotToken({ TEAMS_BOT_APP_ID: "a", TEAMS_BOT_APP_SECRET: "s", TEAMS_BOT_TENANT_ID: TENANT });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0]).toContain(`/${TENANT}/oauth2/v2.0/token`);
    expect(calls[0]).not.toContain("botframework.com/oauth2");
  });

  it("falls back to the shared authority when no tenant is set", async () => {
    const { calls, impl } = fakeFetch();
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await getBotToken({ TEAMS_BOT_APP_ID: "a", TEAMS_BOT_APP_SECRET: "s" });
    } finally {
      globalThis.fetch = original;
    }
    expect(calls[0]).toContain("botframework.com/oauth2/v2.0/token");
  });
});
