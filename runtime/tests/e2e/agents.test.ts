import { describe, it, expect } from "vitest";
import { RUNTIME_URL, authHeaders } from "./helpers";

// ── Helpers ────────────────────────────────────────────────────────────────────

async function chat(slug: string, content: string) {
  const res = await fetch(`${RUNTIME_URL}/api/agents/${slug}/chat`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
  const body = (await res.json()) as { reply: string; runIds: string[] };
  return { status: res.status, body };
}

// ── Auth ───────────────────────────────────────────────────────────────────────

describe("Agent chat auth", () => {
  it("rejects unauthenticated chat requests", async () => {
    const res = await fetch(`${RUNTIME_URL}/api/agents/patch/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAMPLE_RESUME = `
Jane Smith · jane@example.com · (555) 123-4567

Experience
Data Analyst, Acme Corp  2021 – present
  • Wrote SQL queries to analyse monthly sales trends across 12 regions
  • Built Tableau dashboards used by the VP of Sales each week
  • Worked with stakeholders on requirements gathering

Education
B.S. Computer Science, State University, 2021
`.trim();

// ── Greeting smoke tests ───────────────────────────────────────────────────────

describe("Agent greetings", () => {
  for (const slug of ["angie", "beady", "patch", "money"] as const) {
    it(`${slug} responds to a greeting`, async () => {
      const { status, body } = await chat(slug, "Hi, what can you help me with?");
      expect(status).toBe(200);
      expect(typeof body.reply).toBe("string");
      expect(body.reply.length).toBeGreaterThan(10);
    }, 30_000);
  }
});

// ── Conversational Q&A (no tool calls expected) ────────────────────────────────
// These questions are answerable from general domain knowledge — the LLM should
// reply directly without invoking any tool, so runIds must stay empty.

describe("Agent conversational Q&A", () => {
  it("angie: qualities of a strong data analyst candidate", async () => {
    const { status, body } = await chat(
      "angie",
      "What are the most important qualities to look for in a strong data analyst candidate?",
    );
    expect(status).toBe(200);
    expect(body.reply.length).toBeGreaterThan(30);
    expect(body.runIds).toEqual([]);
  }, 30_000);

  it("beady: what NAICS codes are and why they matter", async () => {
    const { status, body } = await chat(
      "beady",
      "What does NAICS stand for and why does it matter for government contracting? Keep it brief.",
    );
    expect(status).toBe(200);
    expect(body.reply.length).toBeGreaterThan(30);
    expect(body.runIds).toEqual([]);
  }, 30_000);

  it("patch: what a well-written IT ticket should include", async () => {
    const { status, body } = await chat(
      "patch",
      "What information should a well-written IT support ticket always include?",
    );
    expect(status).toBe(200);
    expect(body.reply.length).toBeGreaterThan(30);
    expect(body.runIds).toEqual([]);
  }, 30_000);

  it("money: what an indirect rate is in GovCon", async () => {
    const { status, body } = await chat(
      "money",
      "Can you briefly explain what an indirect rate is in government contracting?",
    );
    expect(status).toBe(200);
    expect(body.reply.length).toBeGreaterThan(30);
    expect(body.runIds).toEqual([]);
  }, 30_000);
});

// ── Angie tool: format_resume ─────────────────────────────────────────────────
// Exercises the full agent → tool dispatch → orchestration path without any
// n8n or external credential dependencies. The angie/resume-formatting
// orchestration is LLM-only (no external API calls).

describe("angie/format_resume tool dispatch", () => {
  it("starts a resume-formatting run and returns a run ID", async () => {
    const { status, body } = await chat(
      "angie",
      `Please use your format_resume tool to reformat the following resume for the data-scientist role:\n\n${SAMPLE_RESUME}`,
    );
    expect(status).toBe(200);
    expect(typeof body.reply).toBe("string");
    expect(body.reply.length).toBeGreaterThan(10);

    // The agent must have dispatched format_resume → angie/resume-formatting orchestration.
    expect(body.runIds.length).toBeGreaterThan(0);
    expect(body.runIds[0]).toMatch(UUID_RE);
  }, 60_000);
});
