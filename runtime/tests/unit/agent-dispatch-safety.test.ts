import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { attributionFor, handleOrchestrations } from "../../src/routes/orchestrations";
import { requireUser, requireOpsToken } from "../../src/routes/helpers";
import { runOrchestrationInline } from "../../src/run-inline";
import { PauseSignal } from "../../src/primitives/pause";
import { orchestrations } from "../../src/registry";
import { AGENTS } from "../../../agents";
import type { Env, OrchestrationDefinition } from "../../src/types";
import type { SupabaseClient } from "../../src/db/client";
import { z } from "zod";

// Issue #127 — agent-dispatch safety.
//
//   1. runs dispatched by an agent on behalf of an enduser are attributed to that user
//   2. /run-sync is ops-only
//   3. await_approval on the inline path parks the run as "paused", never "failed"
//   4. /run-sync refuses any orchestration that does not declare readOnly: true

vi.mock("../../src/utils/run-failure-alert", () => ({
  failRun: vi.fn(async () => {}),
  notifyRunSuccess: vi.fn(async () => {}),
}));
import { failRun, notifyRunSuccess } from "../../src/utils/run-failure-alert";

const JWT_SECRET = "test-dispatch-secret";
const END_USER = "11111111-2222-3333-4444-555555555555";

const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_JWT_SECRET: JWT_SECRET,
} as unknown as Env;

/** Mirrors routes/agents.ts mintDispatchToken so the claim shape is exercised for real. */
async function mintDispatchToken(actForUserId?: string, sub = "agent-dispatch"): Promise<string> {
  const enc = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const header = enc(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = enc(JSON.stringify({
    sub,
    user_role: "ops",
    ...(actForUserId ? { act_for: actForUserId } : {}),
    iat: now,
    exp: now + 300,
  }));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${header}.${payload}.${sig}`;
}

function post(path: string, token: string, body = "{}"): Request {
  return new Request(`https://runtime.test${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
}

/** Supabase /auth/v1/user answers with `user`, or 401 when null (forcing the JWT branch). */
function stubSupabaseAuth(user: { id: string; role?: string } | null) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/user")) {
      if (!user) return new Response("nope", { status: 401 });
      return new Response(
        JSON.stringify({ id: user.id, app_metadata: { role: user.role ?? "enduser" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ─── 1. Attribution ───────────────────────────────────────────────────────────

describe("attributionFor (#127 item 1)", () => {
  it("attributes an agent-dispatched run to the end user named by act_for", () => {
    expect(attributionFor({ userId: "agent-dispatch", actFor: END_USER })).toEqual({
      triggered_by: "user",
      triggered_by_user_id: END_USER,
    });
  });

  it("attributes a direct call to the authenticated user", () => {
    expect(attributionFor({ userId: END_USER })).toEqual({
      triggered_by: "user",
      triggered_by_user_id: END_USER,
    });
  });

  it("leaves a genuine machine call as webhook with no user id", () => {
    const attribution = attributionFor({ userId: "agent-dispatch" });
    expect(attribution).toEqual({ triggered_by: "webhook" });
    expect(attribution).not.toHaveProperty("triggered_by_user_id");
  });

  it("prefers act_for over the principal, so agent→agent dispatch keeps the human", () => {
    expect(attributionFor({ userId: "agent-dispatch", actFor: END_USER }).triggered_by_user_id)
      .toBe(END_USER);
  });

  it("only ever emits trigger_source values the enum and the dashboard already know", () => {
    for (const auth of [
      { userId: END_USER },
      { userId: "agent-dispatch", actFor: END_USER },
      { userId: "agent-dispatch" },
    ]) {
      expect(["user", "webhook"]).toContain(attributionFor(auth).triggered_by);
    }
  });
});

describe("act_for is surfaced by the auth helpers without changing the principal", () => {
  it("requireUser reports actFor while keeping the agent-dispatch/ops principal", async () => {
    stubSupabaseAuth(null);
    const result = await requireUser(post("/x", await mintDispatchToken(END_USER)), ENV);
    expect(result).toEqual({ userId: "agent-dispatch", role: "ops", actFor: END_USER });
  });

  it("requireOpsToken reports actFor while keeping the agent-dispatch/ops principal", async () => {
    stubSupabaseAuth(null);
    const result = await requireOpsToken(post("/x", await mintDispatchToken(END_USER)), ENV);
    expect(result).toEqual({ userId: "agent-dispatch", role: "ops", actFor: END_USER });
  });

  it("omits actFor when the dispatch token carries no act_for claim", async () => {
    stubSupabaseAuth(null);
    const result = await requireUser(post("/x", await mintDispatchToken()), ENV);
    expect(result).toEqual({ userId: "agent-dispatch", role: "ops" });
  });

  it("act_for grants nothing: a token without the agent-dispatch sub is still rejected", async () => {
    stubSupabaseAuth(null);
    const forged = await mintDispatchToken(END_USER, "someone-else");
    expect(await requireUser(post("/x", forged), ENV)).toBeInstanceOf(Response);
    expect(await requireOpsToken(post("/x", forged), ENV)).toBeInstanceOf(Response);
  });

  it("never echoes the reserved principal back as an end user", async () => {
    stubSupabaseAuth(null);
    const result = await requireUser(post("/x", await mintDispatchToken("agent-dispatch")), ENV);
    expect(result).toEqual({ userId: "agent-dispatch", role: "ops" });
    expect(attributionFor(result as { userId: string })).toEqual({ triggered_by: "webhook" });
  });
});

// ─── 2 + 4. /run-sync is ops-only and readOnly-only ───────────────────────────

const ctx = {} as ExecutionContext;
const syncUrl = (name: string) =>
  new URL(`https://runtime.test/api/orchestrations/${encodeURIComponent(name)}/run-sync`);
const asyncUrl = (name: string) =>
  new URL(`https://runtime.test/api/orchestrations/${encodeURIComponent(name)}/run`);

describe("/run-sync authorization (#127 item 2)", () => {
  it("refuses a signed-in enduser with 403", async () => {
    stubSupabaseAuth({ id: END_USER, role: "enduser" });
    const req = post("/api/orchestrations/patch/document-query/run-sync", "enduser-token");
    const res = await handleOrchestrations(req, ENV, ctx, syncUrl("patch/document-query"));
    expect(res?.status).toBe(403);
  });

  it("still accepts the internally-minted agent-dispatch principal", async () => {
    stubSupabaseAuth(null);
    const token = await mintDispatchToken(END_USER);
    // Deliberately malformed body: getting "Invalid JSON body" proves both the ops gate
    // and the readOnly gate were passed (both precede body parsing).
    const req = post("/api/orchestrations/patch/document-query/run-sync", token, "not json");
    const res = await handleOrchestrations(req, ENV, ctx, syncUrl("patch/document-query"));
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("leaves the async /run path open to any authenticated user", async () => {
    stubSupabaseAuth({ id: END_USER, role: "enduser" });
    const req = post("/api/orchestrations/patch/document-query/run", "enduser-token", "not json");
    const res = await handleOrchestrations(req, ENV, ctx, asyncUrl("patch/document-query"));
    // Not 401/403: the enduser is admitted and fails only on the malformed body.
    expect(res?.status).toBe(400);
    expect(await res!.json()).toEqual({ error: "Invalid JSON body" });
  });
});

describe("/run-sync readOnly enforcement (#127 item 4)", () => {
  it("refuses a non-readOnly orchestration with a 400 that names the async route", async () => {
    stubSupabaseAuth(null);
    const token = await mintDispatchToken(END_USER);
    const req = post("/api/orchestrations/patch/ticket-ops/run-sync", token);
    const res = await handleOrchestrations(req, ENV, ctx, syncUrl("patch/ticket-ops"));
    expect(res?.status).toBe(400);
    const body = await res!.json() as { error: string };
    expect(body.error).toMatch(/not declared readOnly/);
    expect(body.error).toMatch(/patch\/ticket-ops\/run/);
  });

  it("refuses an orchestration containing await_approval", async () => {
    stubSupabaseAuth(null);
    const token = await mintDispatchToken();
    for (const name of ["patch/inbound-triage", "angie/candidate-sourcing"]) {
      const res = await handleOrchestrations(post(`/x/${name}`, token), ENV, ctx, syncUrl(name));
      expect(res?.status, name).toBe(400);
    }
  });

  it("404s an unknown orchestration before touching the database", async () => {
    stubSupabaseAuth(null);
    const token = await mintDispatchToken();
    const res = await handleOrchestrations(post("/x", token), ENV, ctx, syncUrl("ghost/nope"));
    expect(res?.status).toBe(404);
  });
});

describe("the readOnly declarations themselves", () => {
  const readOnly = [...orchestrations.values()].filter((o) => o.readOnly === true).map((o) => o.name);

  it("flags exactly the audited read-only orchestrations", () => {
    expect(readOnly.sort()).toEqual([
      "angie/recent-resume-jobs",
      // #156: blind resume export. Audited read-only: it reads no table and writes
      // none, calls no integration, and contains no await_approval. Its whole body
      // is two llm_extract passes plus a pure verify/scrub step over the text it
      // was handed, so the inline path is safe and Angie can dispatch it sync.
      "angie/resume-redact",
      "beady/recent-opportunities",
      "cleo/recent-awards",
      "cleo/recent-content",
      "dewey/knowledge-inventory",
      "dewey/knowledge-search",
      "money/data-analyst",
      "patch/document-query",
      // #127: the read-only half of patch/ticket-ops, split out so search_tickets
      // can still dispatch sync while create/update stay off the inline path.
      "patch/ticket-search",
    ]);
  });

  it("never flags a writer", () => {
    for (const name of [
      "patch/ticket-ops", "patch/document-ingest", "patch/staff-request",
      "patch/inbound-triage", "angie/candidate-sourcing", "cleo/award-sweep",
      "beady/opportunity-sweep", "dewey/retag-document", "system/memory-maintenance",
    ]) {
      expect(orchestrations.get(name)?.readOnly, name).not.toBe(true);
    }
  });

  // Canary. A code agent marking a tool `mode: "sync"` no longer makes its orchestration
  // read-only, so any sync mapping onto a non-readOnly orchestration is a 400 at runtime.
  //
  // This started as "exactly one known offender" (patch/ticket-ops, via search_tickets).
  // That was resolved by splitting the pure-read branch into patch/ticket-search, which
  // IS readOnly — so the invariant is now the stronger one: zero offenders. If this
  // fails, a sync tool has been pointed at an orchestration that writes, and it will
  // 400 in production rather than dispatch.
  it("has no code-agent sync mapping pointing at a non-readOnly orchestration", () => {
    const synced = new Set<string>();
    for (const agent of Object.values(AGENTS)) {
      for (const mapping of Object.values(agent.toolMap)) {
        if (mapping.mode === "sync") synced.add(mapping.orchestration);
      }
    }
    const offenders = [...synced].filter((n) => orchestrations.get(n)?.readOnly !== true);
    expect(offenders).toEqual([]);
  });
});

// ─── 3. PauseSignal on the inline path ────────────────────────────────────────

function fakeDb() {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const db = {
    updates,
    updateRun: vi.fn(async (id: string, data: Record<string, unknown>) => { updates.push({ id, data }); }),
    getAgentConfig: vi.fn(async () => null),
    getOrchestrationByName: vi.fn(async () => null),
  };
  return db as unknown as SupabaseClient & typeof db;
}

function orchThatThrows(err: unknown): OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny> {
  return {
    name: "test/pauses",
    version: 1,
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    access: { triggerableBy: [], visibleTo: [] },
    run: async () => { throw err; },
  };
}

describe("runOrchestrationInline PauseSignal handling (#127 item 3)", () => {
  beforeEach(() => stubSupabaseAuth(null));

  it("parks the run as paused, does not fail it, and fires no alert", async () => {
    const db = fakeDb();
    const result = await runOrchestrationInline(ENV, db, orchThatThrows(new PauseSignal("appr-1")), "run-1", {});

    expect(result).toEqual({ status: "paused", approvalId: "appr-1" });
    expect(db.updates).toEqual([{ id: "run-1", data: { status: "paused" } }]);
    expect(failRun).not.toHaveBeenCalled();
    expect(notifyRunSuccess).not.toHaveBeenCalled();
  });

  it("does not write ended_at, so the paused run is not treated as finished", async () => {
    const db = fakeDb();
    await runOrchestrationInline(ENV, db, orchThatThrows(new PauseSignal("appr-2")), "run-2", {});
    expect(db.updates[0]!.data).not.toHaveProperty("ended_at");
  });

  it("recognises a PauseSignal from a duplicated class (agent Workers bundle their own)", async () => {
    class OtherBundlePauseSignal extends Error {
      readonly approvalId = "appr-3";
      constructor() { super("paused"); this.name = "PauseSignal"; }
    }
    const db = fakeDb();
    const result = await runOrchestrationInline(ENV, db, orchThatThrows(new OtherBundlePauseSignal()), "run-3", {});
    expect(result).toEqual({ status: "paused", approvalId: "appr-3" });
    expect(failRun).not.toHaveBeenCalled();
  });

  it("still fails the run (and alerts) for any other error", async () => {
    const db = fakeDb();
    const result = await runOrchestrationInline(ENV, db, orchThatThrows(new Error("boom")), "run-4", {});

    expect(result).toEqual({ status: "failed", error: "boom" });
    expect(failRun).toHaveBeenCalledOnce();
    expect(db.updates).toEqual([]); // failRun (mocked) owns the status write
  });
});
