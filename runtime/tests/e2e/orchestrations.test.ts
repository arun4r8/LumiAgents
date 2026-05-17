import { describe, it, expect } from "vitest";
import { triggerRun, pollRun, authHeaders, RUNTIME_URL } from "./helpers";

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
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("rejects invalid input (422)", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/orchestrations/angie%2Fcandidate-sourcing/run`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ jobTitle: "x" }), // missing required jobDescription
    });
    expect(res.status).toBe(422);
  });
});

// ─── Beady: opportunity-search (SAM.gov) ──────────────────────────────────────

describe("beady/opportunity-search", () => {
  it("triggers and completes a SAM.gov search", async () => {
    const runId = await triggerRun("beady/opportunity-search", {
      query: "cybersecurity software development",
      maxResults: 3,
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 90_000);
    expect(run.status).toBe("completed");
    const output = run.output as { opportunities?: unknown[] };
    expect(Array.isArray(output.opportunities)).toBe(true);
  }, 100_000);
});

// ─── Patch: document-ingest + ticket-ops ──────────────────────────────────────

describe("patch/document-ingest", () => {
  it("ingests a small text document", async () => {
    const runId = await triggerRun("patch/document-ingest", {
      title: "[E2E TEST] smoke test document",
      content: "This is an e2e test document. It contains text about software engineering best practices.",
      source: "e2e-test",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 60_000);
    expect(run.status).toBe("completed");
  }, 70_000);
});

describe("patch/ticket-ops", () => {
  it("creates a Jira ticket", async () => {
    const runId = await triggerRun("patch/ticket-ops", {
      action: "create",
      request: "[E2E TEST] Smoke test ticket — safe to close immediately",
    });
    expect(runId).toBeTruthy();

    const run = await pollRun(runId, 60_000);
    expect(run.status).toBe("completed");
    const output = run.output as { ticketKey?: string };
    expect(output.ticketKey).toMatch(/^[A-Z]+-\d+/);
  }, 70_000);
});
