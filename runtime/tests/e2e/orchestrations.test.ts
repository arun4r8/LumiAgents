import { describe, it, expect, afterAll } from "vitest";
import { triggerRun, pollRun, authHeaders, RUNTIME_URL } from "./helpers";

// Remove documents this suite ingested so the RAG corpus doesn't accumulate test
// residue across CI runs.
//
// This THROWS rather than warns. It used to `console.warn` and return, which is how
// 75 test documents accumulated in production between 2026-06-11 and 2026-09-01: the
// list call had been returning 502 on every single run (GET /api/documents sent
// PostgREST's write-side profile header, so it resolved against `public`), and the
// warning scrolled past in a green job nobody read.
//
// A cleanup that swallows its own failure is not a cleanup. If this suite cannot prove
// it left the corpus as it found it, the deploy should go red.
afterAll(async () => {
  const headers = await authHeaders();

  const res = await fetch(`${RUNTIME_URL}/api/documents`, { headers });
  if (!res.ok) {
    throw new Error(
      `[e2e cleanup] could not list documents (HTTP ${res.status}). Test documents may ` +
      `now be orphaned in this environment's corpus. Body: ${await res.text()}`,
    );
  }

  const docs = await res.json() as Array<{ id: string; source_name: string }>;
  const testDocs = docs.filter((d) => d.source_name.startsWith("[E2E TEST]"));

  // Deleted in bounded-concurrency batches, not one at a time. Serially, clearing the
  // 75-document backlog this bug had built up took longer than vitest's 10s hook budget
  // and the hook timed out after 18 deletes -- the fix working, but not finishing.
  // Steady state is one document per run; the batching is what makes a backlog
  // recoverable in a single run rather than eighteen at a time.
  const failed: string[] = [];
  const BATCH = 10;
  for (let i = 0; i < testDocs.length; i += BATCH) {
    const results = await Promise.all(
      testDocs.slice(i, i + BATCH).map(async (doc) => {
        const del = await fetch(`${RUNTIME_URL}/api/documents/${doc.id}`, { method: "DELETE", headers });
        return del.ok ? null : `${doc.id} (HTTP ${del.status})`;
      }),
    );
    failed.push(...results.filter((r): r is string => r !== null));
  }
  if (failed.length > 0) {
    throw new Error(`[e2e cleanup] failed to delete ${failed.length} test document(s): ${failed.join(", ")}`);
  }

  // Verify against a fresh read rather than trusting the DELETEs: the whole point is
  // to prove the corpus is clean, not that we asked nicely.
  const after = await fetch(`${RUNTIME_URL}/api/documents`, { headers });
  if (after.ok) {
    const remaining = (await after.json() as Array<{ source_name: string }>)
      .filter((d) => d.source_name.startsWith("[E2E TEST]"));
    if (remaining.length > 0) {
      throw new Error(`[e2e cleanup] ${remaining.length} test document(s) still present after cleanup`);
    }
  }

  if (testDocs.length > 0) console.log(`[e2e cleanup] removed ${testDocs.length} test document(s)`);
}, 120_000);

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("Orchestration auth", () => {
  it("rejects unauthenticated run requests", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/angie%2Fcandidate-sourcing/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobTitle: "test", jobDescription: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid token", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/angie%2Fcandidate-sourcing/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer bad.token.here" },
      body: JSON.stringify({ jobTitle: "test", jobDescription: "test" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unknown orchestration name", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/does-not-exist/run`, {
      method: "POST",
      headers: await authHeaders(), // valid token: auth passes, then 404 on unknown name
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid input (422)", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/angie%2Fcandidate-sourcing/run`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ jobTitle: "x" }), // missing required jobDescription
    });
    expect(res.status).toBe(422);
  });
});

// ─── run-sync: awaited, in-process execution (no Workflow) ───────────────────
// dewey/knowledge-inventory needs no external creds (pure Supabase read), so it's
// a clean way to exercise the new /run-sync path without depending on live
// financial/Jira/Apollo data the way the money/patch skip-marked tests do.

describe("Orchestration run-sync", () => {
  it("rejects unauthenticated run-sync requests", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/dewey%2Fknowledge-inventory/run-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unknown orchestration name", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/does-not-exist/run-sync`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("awaits real execution and returns output synchronously, not a bare runId", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/dewey%2Fknowledge-inventory/run-sync`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { runId: string; status: string; output?: { totalDocuments?: number } };
    expect(data.status).toBe("completed");
    expect(data.runId).toBeTruthy();
    expect(typeof data.output?.totalDocuments).toBe("number");
  }, 30_000);

  it("validates input the same way /run does (422), before execution", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/beady%2Frecent-opportunities/run-sync`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ limit: 99999 }), // exceeds the schema's max(50)
    });
    expect(res.status).toBe(422);
  });
});

// ─── GET /api/runs (backs the list_recent_runs chat tool) ─────────────────────

describe("GET /api/runs", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/runs?prefix=dewey/`);
    expect(res.status).toBe(401);
  });

  it("rejects an unknown/unlisted prefix", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/runs?prefix=not-a-real-agent/`, {
      headers: await authHeaders(),
    });
    expect(res.status).toBe(400);
  });

  it("scopes results to the requested agent prefix only", async () => {
    // Seed at least one dewey run so the prefix filter has something to find.
    await fetch(`${RUNTIME_URL}/api/orchestrations/dewey%2Fknowledge-inventory/run-sync`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({}),
    });

    const res = await fetch(`${RUNTIME_URL}/api/runs?prefix=dewey/&limit=50&sinceHours=1`, {
      headers: await authHeaders(),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as { runs: Array<{ orchestrationName: string }> };
    expect(data.runs.length).toBeGreaterThan(0);
    for (const r of data.runs) {
      expect(r.orchestrationName.startsWith("dewey/")).toBe(true);
    }
  }, 30_000);
});

// ─── Patch: document-ingest + ticket-ops ──────────────────────────────────────

describe("patch/document-ingest", () => {
  it("ingests a small text document", async () => {
    const runId = await triggerRun("patch/document-ingest", {
      sourceName: "[E2E TEST] smoke test document",
      sourceKind: "text",
      content: "This is an e2e test document. It contains text about software engineering best practices.",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 150_000);
    expect(run.status).toBe("completed");
  }, 160_000);
});

// Skipped in automated CI: requires Jira credentials (JIRA_EMAIL, JIRA_API_TOKEN).
describe.skip("patch/ticket-ops", () => {
  it("creates a Jira ticket", async () => {
    const runId = await triggerRun("patch/ticket-ops", {
      operation: "create",
      requestText: "[E2E TEST] Smoke test ticket, safe to close immediately",
      requestedBy: "e2e-test-runner",
      notify: false,
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 60_000);
    expect(run.status).toBe("completed");
    const output = run.output as { issueKey?: string };
    expect(output.issueKey).toMatch(/^[A-Z]+-\d+/);
  }, 70_000);
});

// ─── Angie: candidate-sourcing (Apollo) ───────────────────────────────────────
// Skipped in automated CI: requires APOLLO_API_KEY.

describe.skip("angie/candidate-sourcing", () => {
  it("sources candidates from Apollo", async () => {
    const runId = await triggerRun("angie/candidate-sourcing", {
      jobTitle: "Senior Data Engineer",
      jobDescription: "We need a senior data engineer with 5+ years of PostgreSQL and cloud pipeline experience for US government contract work. Must be eligible for security clearance.",
      maxCandidates: 3,
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 120_000);
    expect(run.status).toBe("completed");
  }, 130_000);
});

// ─── Angie: resume-scoring (native) ───────────────────────────────────────────
// Skipped in automated CI: runs a live Claude call (ANTHROPIC_API_KEY) and writes
// resume_results directly. The minimal PDF below has no real content, so scores are nominal.

describe.skip("angie/resume-scoring", () => {
  it("scores a resume against a job description", async () => {
    // Minimal 1-page PDF (bare valid PDF header)
    const minimalPdfBase64 = "JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAvQ2F0YWxvZwovUGFnZXMgMiAwIFIKPj4KZW5kb2JqCjIgMCBvYmoKPDwKL1R5cGUgL1BhZ2VzCi9LaWRzIFszIDAgUl0KL0NvdW50IDEKPJ4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL1BhZ2UKL1BhcmVudCAyIDAgUgovTWVkaWFCb3ggWzAgMCA2MTIgNzkyXQo+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDQKL1Jvb3QgMSAwIFIKPj4Kc3RhcnR4cmVmCjE5MAolJUVPRgo=";
    const runId = await triggerRun("angie/resume-scoring", {
      jobDescription: "Senior PostgreSQL DBA for government contract. Requires clearance eligibility and 5+ years experience.",
      pdfBase64s: [minimalPdfBase64],
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 120_000);
    expect(run.status).toBe("completed");
  }, 130_000);
});

// ─── Beady: govcon-assessment (native) ────────────────────────────────────────
// Skipped in automated CI: runs ~7 live Claude calls + Tavily, writes to
// assessments/incumbent_research. Needs a real opportunity row (or intake text).

describe.skip("beady/govcon-assessment", () => {
  it("runs a native govcon assessment end to end", async () => {
    const runId = await triggerRun("beady/govcon-assessment", {
      opportunityId: "00000000-0000-0000-0000-000000000001", // replace with real ID
      summaryText: "Test solicitation for IT modernization services.",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 180_000);
    expect(run.status).toBe("completed");
  }, 190_000);
});

// ─── Beady: past-performance-seed (CF Workers AI + Supabase) ──────────────────
// Skipped in automated CI: requires a real past_performance row UUID in the DB.

describe.skip("beady/past-performance-seed", () => {
  it("embeds a past performance record into the RAG index", async () => {
    const runId = await triggerRun("beady/past-performance-seed", {
      pastPerformanceId: "00000000-0000-0000-0000-000000000001", // replace with real ID
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 120_000);
    expect(run.status).toBe("completed");
    const output = run.output as { ingested?: number };
    expect(typeof output.ingested).toBe("number");
  }, 130_000);
});

// ─── Money: data-analyst (Supabase + LLM) ─────────────────────────────────────
// Skipped in automated CI: queries live financial data in Supabase; safe to
// enable once the money schema is populated in the target environment.

describe.skip("money/data-analyst", () => {
  it("answers a financial question with SQL", async () => {
    const runId = await triggerRun("money/data-analyst", {
      question: "What is the total expended amount across all active contracts this fiscal year?",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 120_000);
    expect(run.status).toBe("completed");
    const output = run.output as { answer?: string };
    expect(typeof output.answer).toBe("string");
  }, 130_000);
});

// ─── Money: financial-report (Supabase + LLM) ─────────────────────────────────
// Skipped in automated CI, same as data-analyst: needs populated financial data.

describe.skip("money/financial-report", () => {
  it("generates a burn-rate report", async () => {
    const runId = await triggerRun("money/financial-report", {
      reportType: "burn-rate",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 120_000);
    expect(run.status).toBe("completed");
    const output = run.output as { summary?: string };
    expect(typeof output.summary).toBe("string");
  }, 130_000);
});

// ─── Patch: inbound-triage (LLM + email) ──────────────────────────────────────
// Skipped in automated CI: emails the digest subscribers (RESEND_API_KEY).

describe.skip("patch/inbound-triage", () => {
  it("classifies an inbound message and routes it", async () => {
    const runId = await triggerRun("patch/inbound-triage", {
      source: "email",
      messageId: `e2e-test-${Date.now()}`,
      from: "contractor@client.gov",
      subject: "Contract modification question",
      body: "Hi, I wanted to ask about the timeline for the upcoming contract modification on Task Order 4. Can you let me know when we should expect the updated PWS?",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 60_000);
    expect(run.status).toBe("completed");
  }, 70_000);
});

// ─── Patch: staff-request (Jira + LLM + email) ────────────────────────────────
// Skipped in automated CI: creates a Jira ticket in the HR project and emails ops.
// Requires JIRA_EMAIL, JIRA_API_TOKEN, RESEND_API_KEY.

describe.skip("patch/staff-request", () => {
  it("creates an HR staff request and Jira ticket", async () => {
    const runId = await triggerRun("patch/staff-request", {
      requestType: "new_hire",
      requestText: "[E2E TEST] Need a cleared Oracle DBA for Task Order 7 starting next quarter. Safe to close immediately.",
      requestedBy: "e2e-test-runner",
      urgency: "this_month",
      notify: false,
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 60_000);
    expect(run.status).toBe("completed");
    const output = run.output as { issueKey?: string };
    expect(output.issueKey).toMatch(/^[A-Z]+-\d+/);
  }, 70_000);
});

// ─── Patch: vault-sync (GitHub → Supabase RAG) ────────────────────────────────
// Skipped in automated CI: requires GITHUB_API_TOKEN with repo read access
// and the target Obsidian vault repo to exist.

describe.skip("patch/vault-sync", () => {
  it("syncs Obsidian vault markdown into the RAG index", async () => {
    const runId = await triggerRun("patch/vault-sync", {
      repoOwner: "LumitureLabs",
      repoName:  "LumiKnowledge",
      branch: "main",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 180_000);
    expect(run.status).toBe("completed");
    const output = run.output as { ingested?: number; skipped?: number; errors?: string[] };
    expect(typeof output.ingested).toBe("number");
    expect(output.errors).toHaveLength(0);
  }, 190_000);
});
