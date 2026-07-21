import { z } from "zod";
import { defineOrchestration, step, llm_extract } from "@/runtime";
import type { Env } from "@/runtime";
import { tavilySearch } from "../../../integrations/tavily/search";

// Discover government agency industry days (industry days, vendor days, small-business
// matchmaking) from two sources: SAM.gov Special Notices (ptype=s) and a Tavily web
// sweep for agency event pages (e.g. sba.gov/event/…). Score relevance to Lumiture,
// dedup via a content-hash ledger, and upsert into industry_days.

export const inputSchema = z.object({
  minScore: z.number().int().min(1).max(10).default(4).describe("Minimum relevance score to keep."),
  postedWithinDays: z.number().int().min(1).max(365).default(90).describe("SAM: notices posted in the last N days."),
});

export const outputSchema = z.object({
  found: z.number(),
  kept: z.number(),
  events: z.array(z.object({ title: z.string(), agency: z.string().nullable(), eventDate: z.string().nullable(), fitScore: z.number() })),
});

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra };
}

const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

// A candidate event before scoring. `source` distinguishes the two feeds.
interface Candidate { eventId: string; source: "sam_gov" | "web"; url: string; title: string; content: string; agency: string | null; }

const SAM_TITLE_KEYWORDS = ["industry day", "vendor outreach", "small business matchmaking"];
const WEB_QUERIES = [
  "federal government agency industry day event vendors small business",
  "government contracting industry day OR vendor day OR matchmaking upcoming",
];

export default defineOrchestration({
  name: "beady/industry-day-sweep",
  version: 1,
  triggerMode: "agent",
  description:
    "Discover government agency industry days (SAM.gov Special Notices + web), score relevance to Lumiture, and upsert into industry_days.",
  inputSchema,
  outputSchema,
  access: { triggerableBy: ["role:ops"], visibleTo: ["role:ops"] },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const env = ctx.env;

    // Step 1: gather candidates from SAM Special Notices + Tavily.
    const candidates = await step(ctx, "gather-candidates", async () => {
      const out: Candidate[] = [];

      // SAM.gov Special Notices (ptype=s), one search per title keyword.
      const to = new Date();
      const from = new Date(to.getTime());
      from.setDate(from.getDate() - input.postedWithinDays);
      for (const kw of SAM_TITLE_KEYWORDS) {
        try {
          const params = new URLSearchParams({
            api_key: env.SAM_GOV_API_KEY, limit: "20", ptype: "s", status: "active",
            postedFrom: fmt(from), postedTo: fmt(to), title: kw,
          });
          const res = await ctx.fetch(`https://api.sam.gov/opportunities/v2/search?${params.toString()}`, { headers: { Accept: "application/json" } });
          if (!res.ok) { console.warn(`[industry-day] SAM ${kw} → ${res.status}`); continue; }
          const data = (await res.json()) as { opportunitiesData?: Array<{ noticeId?: string; title?: string; fullParentPathName?: string; description?: string; uiLink?: string }> };
          for (const o of data.opportunitiesData ?? []) {
            if (!o.noticeId || !o.title) continue;
            out.push({
              eventId: o.noticeId, source: "sam_gov", url: o.uiLink ?? `https://sam.gov/opp/${o.noticeId}/view`,
              title: o.title, content: (o.description ?? "").slice(0, 1200),
              agency: (o.fullParentPathName ?? "").split(".")[0] || null,
            });
          }
        } catch (e) { console.warn(`[industry-day] SAM ${kw} error`, e); }
      }

      // Tavily web sweep for agency-hosted event pages.
      for (const q of WEB_QUERIES) {
        const hits = await tavilySearch(env, { query: q, maxResults: 6 });
        for (const h of hits) {
          out.push({ eventId: fnv1a(h.url), source: "web", url: h.url, title: h.title, content: (h.content ?? "").slice(0, 1200), agency: null });
        }
      }

      // De-dup within this run by eventId (keep first).
      const seen = new Set<string>();
      return out.filter((c) => (seen.has(c.eventId) ? false : (seen.add(c.eventId), true)));
    });

    // Step 2: skip candidates already scored with the same content.
    const fresh = await step(ctx, "dedup-ledger", async () => {
      const ledger = new Map<string, string>();
      try {
        const res = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/industry_day_scored?select=event_id,content_hash`, { headers: sbHeaders(env) });
        if (res.ok) for (const r of (await res.json()) as Array<{ event_id: string; content_hash: string }>) ledger.set(r.event_id, r.content_hash);
      } catch (e) { console.warn("[industry-day] ledger lookup failed", e); }
      return candidates.filter((c) => ledger.get(c.eventId) !== fnv1a(c.title + c.content));
    });

    if (fresh.length === 0) return { found: candidates.length, kept: 0, events: [] };

    // Step 3: LLM-score relevance + extract event details.
    const scored = await llm_extract(ctx, {
      name: "score-industry-days",
      prompt: `
You are Beady, Lumiture's GovCon BD assistant. Score each candidate as a *government agency industry day / vendor outreach / small-business matchmaking event* for Lumiture.

Lumiture: small US database-management + AI/ML firm, DC-area, federal focus. Values events where it can meet agency buyers/primes it could subcontract to, in IT/data/AI.

For each item decide if it is genuinely an industry-day-type EVENT (not a solicitation, award, or generic page). If it is NOT an event, give fitScore 1 and recommendation "skip".

Extract: title, agency (hosting agency, or null), eventDate (ISO YYYY-MM-DD if determinable, else null), location (city / "Virtual" / null), format ("in-person" | "virtual" | "hybrid" | null), registrationUrl (if present, else null), description (1-2 sentences), fitScore (1-10), fitReason (1 sentence), recommendation ("attend" fit>=7 | "consider" fit 4-6 | "skip" fit<=3).

Only return items scoring >= ${input.minScore}.
      `.trim(),
      input: { items: fresh.map((c, i) => ({ id: i, source: c.source, url: c.url, title: c.title, content: c.content, agency: c.agency })) },
      schema: z.object({
        events: z.array(z.object({
          id: z.number(),
          title: z.string(),
          agency: z.string().nullable(),
          eventDate: z.string().nullable(),
          location: z.string().nullable(),
          format: z.string().nullable(),
          registrationUrl: z.string().nullable(),
          description: z.string(),
          fitScore: z.number().int().min(1).max(10),
          fitReason: z.string(),
          recommendation: z.enum(["attend", "consider", "skip"]),
        })),
      }),
    });

    // Step 4: upsert to industry_days + record every fresh candidate in the ledger.
    const kept = await step(ctx, "persist", async () => {
      const rows = scored.events
        .map((s) => { const raw = fresh[s.id]; return raw ? { s, raw } : null; })
        .filter((x): x is { s: (typeof scored.events)[number]; raw: Candidate } => x !== null)
        .map(({ s, raw }) => ({
          event_id: raw.eventId, title: s.title, agency: s.agency,
          event_date: s.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(s.eventDate) ? s.eventDate : null,
          location: s.location, format: s.format, registration_url: s.registrationUrl,
          source: raw.source, source_url: raw.url, description: s.description,
          fit_score: s.fitScore, fit_reason: s.fitReason, recommendation: s.recommendation,
          last_scored_at: new Date().toISOString(),
        }));

      if (rows.length > 0) {
        const res = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/industry_days?on_conflict=event_id`, {
          method: "POST", headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(rows),
        });
        if (!res.ok) throw new Error(`industry_days upsert → ${res.status}: ${await res.text()}`);
      }

      // Ledger: every fresh candidate (even skipped) so we don't re-score it next week.
      const ledgerRows = fresh.map((c) => ({ event_id: c.eventId, content_hash: fnv1a(c.title + c.content), scored_at: new Date().toISOString() }));
      const lres = await ctx.fetch(`${env.SUPABASE_URL}/rest/v1/industry_day_scored?on_conflict=event_id`, {
        method: "POST", headers: sbHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(ledgerRows),
      });
      if (!lres.ok) console.warn(`[industry-day] ledger upsert → ${lres.status}`);

      return rows;
    });

    return {
      found: candidates.length,
      kept: kept.length,
      events: kept.map((r) => ({ title: r.title, agency: r.agency, eventDate: r.event_date, fitScore: r.fit_score })),
    };
  },
});
