/**
 * DOUBLE PROVENANCE: PostgREST request/response shapes, modelled on
 * https://postgrest.org/en/stable/references/api.html.
 * Not modelled: a 404 from a schema-qualified path, which parses as a valid empty
 * body and is how #223 stayed invisible; nor `Prefer: return=representation`
 * returning an array where a caller expects an object. See docs/testing-doubles.md.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import {
  canSeeRun,
  canRerunRun,
  isCancellable,
  CANCELLABLE,
  terminateRunInstance,
  handleRuns,
} from "../../src/routes/runs";
import { orchestrations } from "../../src/registry";
import type { Env, OrchestrationDefinition, RunStatus } from "../../src/types";

/**
 * Run actions: POST /api/runs/:id/rerun and POST /api/runs/:id/cancel.
 *
 * Three things are worth testing and are tested here:
 *
 *   1. The authorization predicates. They are the code duplicate of the RLS
 *      policies on orchestration.runs / orchestration.orchestrations, and the
 *      runtime reads through the service role, so nothing else would catch a
 *      mistake in them.
 *   2. The re-run input re-validation. The whole point of the endpoint refusing
 *      with 422 is that a schema which has moved on must not be handed a payload
 *      it cannot parse.
 *   3. The cancel state machine, and — most importantly — that
 *      `terminateRunInstance` NEVER reports `terminated: true` for a call that
 *      did not actually terminate anything. Everything the UI says about what
 *      cancelling did rests on that boolean being honest.
 */

const OPS = { userId: "ops-user", role: "ops" };
const ALICE = { userId: "11111111-1111-1111-1111-111111111111", role: "enduser" };
const BOB = { userId: "22222222-2222-2222-2222-222222222222", role: "enduser" };

const RUN_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ORCH_ID = "99999999-8888-7777-6666-555555555555";
const NEW_RUN_ID = "12345678-1234-1234-1234-123456789abc";

const ACTIVE = { id: ORCH_ID, name: "test/rerunnable", version: 3, is_active: true };

function runRow(over: Partial<{
  triggeredByUserId: string | null;
  approverUserIds: string[];
  orchestration: typeof ACTIVE | null;
}> = {}) {
  return {
    triggeredByUserId: ALICE.userId,
    approverUserIds: [] as string[],
    orchestration: ACTIVE as typeof ACTIVE | null,
    ...over,
  };
}

// ─── 1. Authorization ─────────────────────────────────────────────────────────

describe("canSeeRun — the code duplicate of enduser_read_own_or_approval", () => {
  it("lets ops see any run, including one attributed to nobody", () => {
    expect(canSeeRun(runRow({ triggeredByUserId: null }), OPS)).toBe(true);
  });

  it("lets an enduser see a run they triggered", () => {
    expect(canSeeRun(runRow(), ALICE)).toBe(true);
  });

  it("lets an enduser see a run they are the approver on", () => {
    const run = runRow({ triggeredByUserId: ALICE.userId, approverUserIds: [BOB.userId] });
    expect(canSeeRun(run, BOB)).toBe(true);
  });

  it("hides someone else's run from an enduser", () => {
    expect(canSeeRun(runRow(), BOB)).toBe(false);
  });

  it("never treats an unattributed run as visible to an enduser", () => {
    // triggered_by_user_id IS NULL must not match a caller whose id is also falsy
    // by accident — a cron/webhook run belongs to nobody.
    expect(canSeeRun(runRow({ triggeredByUserId: null }), ALICE)).toBe(false);
    expect(canSeeRun(runRow({ triggeredByUserId: null }), { userId: "", role: "enduser" })).toBe(false);
  });
});

describe("canRerunRun — visibility PLUS the entitlement to trigger", () => {
  it("lets ops re-run a run of a deactivated orchestration", () => {
    const run = runRow({ orchestration: { ...ACTIVE, is_active: false } });
    expect(canRerunRun(run, OPS)).toBe(true);
  });

  it("lets an enduser re-run their own run of an active orchestration", () => {
    expect(canRerunRun(runRow(), ALICE)).toBe(true);
  });

  it("refuses an enduser whose orchestration is no longer active", () => {
    const run = runRow({ orchestration: { ...ACTIVE, is_active: false } });
    expect(canSeeRun(run, ALICE)).toBe(true);   // they can still READ it
    expect(canRerunRun(run, ALICE)).toBe(false); // but not dispatch it again
  });

  it("refuses an enduser whose orchestration row is gone entirely", () => {
    expect(canRerunRun(runRow({ orchestration: null }), ALICE)).toBe(false);
  });

  it("never lets re-run succeed where see-run fails", () => {
    for (const orchestration of [ACTIVE, { ...ACTIVE, is_active: false }, null]) {
      const run = runRow({ orchestration });
      if (!canSeeRun(run, BOB)) expect(canRerunRun(run, BOB)).toBe(false);
    }
  });
});

// ─── 2. The cancel state machine ──────────────────────────────────────────────

describe("isCancellable", () => {
  const ALL: RunStatus[] = ["pending", "running", "paused", "completed", "failed", "cancelled"];

  it("accepts exactly the live statuses", () => {
    const live = ALL.filter(isCancellable);
    expect(live.sort()).toEqual(["paused", "pending", "running"]);
  });

  it("refuses every terminal status, cancelled included (no double-cancel)", () => {
    for (const status of ["completed", "failed", "cancelled"] as RunStatus[]) {
      expect(isCancellable(status), status).toBe(false);
    }
  });

  it("covers every value of the run_status enum, so a new one cannot be silently cancellable", () => {
    for (const status of ALL) expect(typeof isCancellable(status)).toBe("boolean");
    expect(CANCELLABLE.size).toBe(3);
  });
});

// ─── 3. terminateRunInstance: it must never overclaim ─────────────────────────

function envWith(workflow: unknown): Env {
  return { ORCHESTRATION_WORKFLOW: workflow } as unknown as Env;
}

describe("terminateRunInstance", () => {
  it("reports terminated:true only when terminate() actually resolved", async () => {
    const terminate = vi.fn(async () => {});
    const get = vi.fn(async () => ({ terminate }));
    const result = await terminateRunInstance(envWith({ get }), RUN_ID);
    expect(result).toEqual({ terminated: true });
    // The instance id IS the run id — every dispatch site creates it that way.
    expect(get).toHaveBeenCalledWith(RUN_ID);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("reports terminated:false when the Workflows binding is absent (local dev)", async () => {
    const result = await terminateRunInstance(envWith(undefined), RUN_ID);
    expect(result.terminated).toBe(false);
    expect(result).toHaveProperty("reason");
  });

  it("reports terminated:false when there is no instance to get (inline / bookkeeping runs)", async () => {
    const get = vi.fn(async () => { throw new Error("instance not found"); });
    const result = await terminateRunInstance(envWith({ get }), RUN_ID);
    expect(result).toEqual({ terminated: false, reason: "instance not found" });
  });

  it("reports terminated:false when terminate() rejects (already complete/errored)", async () => {
    const get = vi.fn(async () => ({
      terminate: async () => { throw new Error("instance is already complete"); },
    }));
    const result = await terminateRunInstance(envWith({ get }), RUN_ID);
    expect(result).toEqual({ terminated: false, reason: "instance is already complete" });
  });

  it("never returns terminated:true on any failing path", async () => {
    const failures: unknown[] = [
      undefined,
      {},                                                       // binding without .get
      { get: async () => { throw new Error("boom"); } },
      { get: async () => ({ terminate: async () => { throw "nope"; } }) },
    ];
    for (const wf of failures) {
      expect((await terminateRunInstance(envWith(wf), RUN_ID)).terminated).toBe(false);
    }
  });
});

// ─── 4. The endpoints end to end ──────────────────────────────────────────────

const ENV_BASE = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_JWT_SECRET: "test-secret",
};

const ctx = {} as ExecutionContext;

interface StubOpts {
  /** The run row `getRunForAction` resolves. null → 404. */
  run?: Record<string, unknown> | null;
  /** Rows the conditional cancel PATCH returns. [] → the run was already terminal. */
  cancelResult?: Record<string, unknown>[];
  /** The run row a post-race re-read returns. */
  runAfterRace?: Record<string, unknown> | null;
  /** [] → the orchestrations table has no row for this name+version yet. */
  orchestrationRows?: Record<string, unknown>[];
}

/**
 * Stub Supabase for one request. Records every write so the tests can assert what
 * was actually persisted (attribution, rerun_of, the conditional cancel filter).
 */
function stubSupabase(caller: { id: string; role: string }, opts: StubOpts = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let runReads = 0;

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body });

    if (url.includes("/auth/v1/user")) {
      return Response.json({ id: caller.id, app_metadata: { role: caller.role } });
    }
    if (url.includes("claim_rate_limit")) return Response.json(true);

    if (url.includes("/rest/v1/runs") && method === "GET") {
      runReads += 1;
      const row = runReads === 1 ? opts.run : (opts.runAfterRace ?? opts.run);
      return Response.json(row ? [row] : []);
    }
    if (url.includes("/rest/v1/runs") && method === "PATCH") {
      return Response.json(opts.cancelResult ?? [{ id: RUN_ID, status: "cancelled" }]);
    }
    if (url.includes("/rest/v1/runs") && method === "POST") {
      return Response.json([{ ...(body as object), id: NEW_RUN_ID, created_at: "now" }]);
    }
    if (url.includes("/rest/v1/run_steps")) return new Response(null, { status: 204 });
    if (url.includes("/rest/v1/orchestrations")) {
      return Response.json(
        opts.orchestrationRows ??
          [{ id: ORCH_ID, name: ACTIVE.name, version: ACTIVE.version, is_active: true, model: null }],
      );
    }
    throw new Error(`unexpected fetch in test: ${method} ${url}`);
  }));

  return calls;
}

/** A run row in the shape PostgREST returns for `getRunForAction`. */
function dbRun(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    status: "running",
    input: { topic: "widgets" },
    orchestration_id: ORCH_ID,
    orchestration_version: 3,
    triggered_by_user_id: ALICE.userId,
    started_at: "2026-08-05T10:00:00Z",
    ended_at: null,
    rerun_of: null,
    orchestrations: ACTIVE,
    approvals: [],
    ...over,
  };
}

function post(path: string): { req: Request; url: URL } {
  const href = `https://runtime.test${path}`;
  return {
    req: new Request(href, { method: "POST", headers: { Authorization: "Bearer tok" } }),
    url: new URL(href),
  };
}

/** Register a throwaway orchestration so the input schema under test is ours. */
function register(inputSchema: z.ZodTypeAny) {
  const def: OrchestrationDefinition<z.ZodTypeAny, z.ZodTypeAny> = {
    name: ACTIVE.name,
    version: ACTIVE.version,
    inputSchema,
    outputSchema: z.object({}),
    access: { triggerableBy: ["ops"], visibleTo: ["ops"] },
    run: async () => ({}),
  };
  orchestrations.set(ACTIVE.name, def);
}

function envWithWorkflow(create = vi.fn(async () => ({})), get?: unknown): Env {
  return {
    ...ENV_BASE,
    ORCHESTRATION_WORKFLOW: { create, get: get ?? (async () => ({ terminate: async () => {} })) },
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  orchestrations.delete(ACTIVE.name);
});

describe("POST /api/runs/:id/rerun — input re-validation against the CURRENT schema", () => {
  it("422s when the stored input no longer satisfies the schema, and does not dispatch", async () => {
    // The schema has since gained a required field the original run never carried.
    register(z.object({ topic: z.string(), audience: z.string() }));
    stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun() });
    const create = vi.fn(async () => ({}));

    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(create), ctx, url);

    expect(res?.status).toBe(422);
    const body = await res!.json() as { error: string; issues: { path: string[] }[] };
    expect(body.error).toMatch(/no longer satisfies the current input schema/);
    expect(body.issues.some((i) => i.path.includes("audience"))).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("dispatches a NEW run when the input still validates, attributed to the caller", async () => {
    register(z.object({ topic: z.string() }));
    const calls = stubSupabase({ id: BOB.userId, role: "ops" }, { run: dbRun() });
    const create = vi.fn(async () => ({}));

    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(create), ctx, url);

    expect(res?.status).toBe(202);
    expect(await res!.json()).toMatchObject({ runId: NEW_RUN_ID, rerunOf: RUN_ID, status: "running" });

    const insert = calls.find((c) => c.method === "POST" && c.url.includes("/rest/v1/runs"));
    expect(insert?.body).toMatchObject({
      status: "running",
      input: { topic: "widgets" },
      rerun_of: RUN_ID,
      // Attributed to whoever pressed Re-run, NOT to the original run's owner.
      triggered_by: "user",
      triggered_by_user_id: BOB.userId,
    });
    // The new instance is created under the NEW run's id, never the original's.
    expect(create).toHaveBeenCalledWith({
      id: NEW_RUN_ID,
      params: { runId: NEW_RUN_ID, orchestrationName: ACTIVE.name },
    });
  });

  it("never mutates the original run", async () => {
    register(z.object({ topic: z.string() }));
    const calls = stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun() });
    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("409s when the orchestration is no longer registered in code", async () => {
    // deliberately NOT registered
    stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun() });
    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(res?.status).toBe(409);
    expect((await res!.json() as { error: string }).error).toMatch(/no longer registered/);
  });

  it("409s when the code is registered but the DB row is not, and does not dispatch", async () => {
    // The deploy-ordering window: a definition's `version` was bumped and shipped,
    // but its registration migration has not applied yet, so the orchestrations
    // table has no matching row. `getOrchestrationByName` throws a bare Error on
    // that path; unguarded it would surface as a 500 with a raw internal message.
    // It must be a deliberate 409 that names the real cause, and it must not
    // create a run row or a Workflow instance on the way out.
    register(z.object({ topic: z.string() }));
    const calls = stubSupabase({ id: OPS.userId, role: "ops" }, {
      run: dbRun(),
      orchestrationRows: [],
    });
    const create = vi.fn(async () => ({}));
    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(create), ctx, url);

    expect(res?.status).toBe(409);
    expect((await res!.json() as { error: string }).error).toMatch(/registration migration/);
    expect(create).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.url.includes("/rest/v1/runs") && c.method === "POST")).toHaveLength(0);
  });

  it("404s — not 403 — a run an enduser cannot see, leaking nothing about its existence", async () => {
    register(z.object({ topic: z.string() }));
    stubSupabase({ id: BOB.userId, role: "enduser" }, { run: dbRun() });
    const create = vi.fn(async () => ({}));
    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(create), ctx, url);
    expect(res?.status).toBe(404);
    expect(await res!.json()).toEqual({ error: "Run not found" });
    expect(create).not.toHaveBeenCalled();
  });

  it("403s the visible-but-not-entitled case: enduser, deactivated orchestration", async () => {
    register(z.object({ topic: z.string() }));
    stubSupabase({ id: ALICE.userId, role: "enduser" }, {
      run: dbRun({ orchestrations: { ...ACTIVE, is_active: false } }),
    });
    const create = vi.fn(async () => ({}));
    const { req, url } = post(`/api/runs/${RUN_ID}/rerun`);
    const res = await handleRuns(req, envWithWorkflow(create), ctx, url);
    expect(res?.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("404s a malformed run id before it can reach PostgREST", async () => {
    stubSupabase({ id: OPS.userId, role: "ops" });
    const { req, url } = post("/api/runs/not-a-uuid/rerun");
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(res?.status).toBe(404);
  });
});

describe("POST /api/runs/:id/cancel — state machine and honesty", () => {
  it("running → cancelled, and says so only because terminate() succeeded", async () => {
    const calls = stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun({ status: "running" }) });
    const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);

    expect(res?.status).toBe(200);
    const body = await res!.json() as { status: string; terminated: boolean; effect: string; message: string };
    expect(body).toMatchObject({ status: "cancelled", terminated: true, effect: "terminated" });
    expect(body.message).toMatch(/cannot be recalled/);

    // The UPDATE is conditional on a live status — that filter is the concurrency gate.
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/rest/v1/runs"));
    expect(patch?.url).toContain("status=in.(pending,running,paused)");
    expect(patch?.body).toMatchObject({ status: "cancelled" });
    expect(patch?.body).toHaveProperty("ended_at");

    // The step left mid-flight is closed out so the timeline stops pulsing.
    expect(calls.some((c) => c.url.includes("/rest/v1/run_steps") && c.method === "PATCH")).toBe(true);
  });

  it("pending and paused are cancellable too", async () => {
    for (const status of ["pending", "paused"]) {
      stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun({ status }) });
      const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
      const res = await handleRuns(req, envWithWorkflow(), ctx, url);
      expect(res?.status, status).toBe(200);
      vi.unstubAllGlobals();
    }
  });

  it("completed → 409, and writes nothing", async () => {
    const calls = stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun({ status: "completed" }) });
    const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);

    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ error: "Run is completed and cannot be cancelled.", status: "completed" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("failed and cancelled → 409 as well", async () => {
    for (const status of ["failed", "cancelled"]) {
      stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun({ status }) });
      const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
      const res = await handleRuns(req, envWithWorkflow(), ctx, url);
      expect(res?.status, status).toBe(409);
      vi.unstubAllGlobals();
    }
  });

  it("409s when the run settles between the read and the write (the DB, not us, decides)", async () => {
    stubSupabase({ id: OPS.userId, role: "ops" }, {
      run: dbRun({ status: "running" }),
      cancelResult: [],                                  // the conditional UPDATE matched nothing
      runAfterRace: dbRun({ status: "completed" }),
    });
    const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(res?.status).toBe(409);
    expect(await res!.json()).toMatchObject({ status: "completed" });
  });

  it("still cancels when the instance cannot be terminated — but reports it honestly", async () => {
    stubSupabase({ id: OPS.userId, role: "ops" }, { run: dbRun({ status: "running" }) });
    const env = envWithWorkflow(vi.fn(), async () => { throw new Error("instance not found"); });

    const { req, url } = post(`/api/runs/${RUN_ID}/cancel`);
    const res = await handleRuns(req, env, ctx, url);

    expect(res?.status).toBe(200);
    const body = await res!.json() as { status: string; terminated: boolean; effect: string; message: string };
    expect(body.status).toBe("cancelled");     // the row IS cancelled …
    expect(body.terminated).toBe(false);       // … and we do not pretend it stopped
    expect(body.effect).toBe("marked-only");
    expect(body.message).toMatch(/could not be terminated/);
    expect(body.message).toMatch(/keep going until it finishes/);
  });

  it("lets the approver on a run cancel it, and a stranger neither see nor cancel it", async () => {
    stubSupabase({ id: BOB.userId, role: "enduser" }, {
      run: dbRun({ approvals: [{ requested_from_user_id: BOB.userId }] }),
    });
    const approver = post(`/api/runs/${RUN_ID}/cancel`);
    expect((await handleRuns(approver.req, envWithWorkflow(), ctx, approver.url))?.status).toBe(200);
    vi.unstubAllGlobals();

    stubSupabase({ id: BOB.userId, role: "enduser" }, { run: dbRun() });
    const stranger = post(`/api/runs/${RUN_ID}/cancel`);
    const res = await handleRuns(stranger.req, envWithWorkflow(), ctx, stranger.url);
    expect(res?.status).toBe(404);
  });

  it("requires authentication", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    const url = new URL(`https://runtime.test/api/runs/${RUN_ID}/cancel`);
    const req = new Request(url.href, { method: "POST" });
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(res?.status).toBe(401);
  });
});

describe("the existing GET /api/runs is untouched", () => {
  it("still rejects an unknown agent prefix", async () => {
    stubSupabase({ id: OPS.userId, role: "ops" });
    const url = new URL("https://runtime.test/api/runs?prefix=ghost/");
    const req = new Request(url.href, { headers: { Authorization: "Bearer tok" } });
    const res = await handleRuns(req, envWithWorkflow(), ctx, url);
    expect(res?.status).toBe(400);
  });

  it("returns null for a path it does not own", async () => {
    const url = new URL("https://runtime.test/api/other");
    expect(await handleRuns(new Request(url.href), envWithWorkflow(), ctx, url)).toBeNull();
  });
});
