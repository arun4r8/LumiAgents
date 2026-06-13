import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { claimBudget, DAILY_BUDGET } from "../budget";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const sbirSearchInputSchema = z.object({
  keyword: z.string().optional().describe("Free-text keyword search across title and abstract"),
  component: z
    .array(z.string())
    .optional()
    .describe("DoD branch filter — e.g. ['ARMY', 'USAF', 'NAVY', 'SOCOM']"),
  topicStatus: z
    .enum(["Open", "Closed", "Pre-Release"])
    .default("Open")
    .describe("Topic status filter"),
  limit: z.number().int().min(1).max(200).default(50),
});

export const sbirTopicSchema = z.object({
  topicId: z.number(),
  topicNumber: z.string().describe("e.g. ARM26BX01-NP003"),
  title: z.string(),
  program: z.string().describe("SBIR or STTR"),
  phase: z.string().describe("Phase I, Phase II, etc."),
  agency: z.string().nullable(),
  component: z.string().nullable().describe("ARMY, USAF, NAVY, etc."),
  solicitationTitle: z.string().nullable(),
  openDate: z.string().nullable().describe("ISO date"),
  closeDate: z.string().nullable().describe("ISO date"),
  topicStatus: z.string(),
  abstract: z.string().nullable().describe("Truncated topic description"),
  sourceUrl: z.string().describe("Link to the topic on dodsbirsttr.mil"),
});

export const sbirSearchOutputSchema = z.object({
  totalElements: z.number(),
  topics: z.array(sbirTopicSchema),
});

export type SbirTopic = z.infer<typeof sbirTopicSchema>;

// ─── Raw API types ────────────────────────────────────────────────────────────

interface RawSbirTopic {
  topicId?: number;
  topicNumber?: string;
  title?: string;
  program?: string;
  phase?: string;
  agency?: string;
  component?: string;
  // API uses both field names across versions
  solicitationTitle?: string;
  solicitationNumber?: string;
  openDate?: string;
  closeDate?: string;
  topicStatus?: string;
  abstract?: string;
  description?: string;
}

interface RawSbirPage {
  content?: RawSbirTopic[];
  totalElements?: number;
}

// ─── Base URL ─────────────────────────────────────────────────────────────────

const BASE = "https://dodsbirsttr.mil/topics-app/api/public";

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const sbirTopicSearch = defineTool({
  name: "sbirTopicSearch",
  inputSchema: sbirSearchInputSchema,
  outputSchema: sbirSearchOutputSchema,
  async run(ctx, input) {
    // Over the daily budget → return empty (SBIR has no hard key limit; tracked for visibility).
    if (!(await claimBudget(ctx.env, "sbir", DAILY_BUDGET.sbir))) {
      return { totalElements: 0, topics: [] };
    }
    // Fetch up to `limit` topics in one page — the portal has ~100-200 open at any time
    const params = new URLSearchParams({
      page: "0",
      size: String(input.limit),
      topicStatus: input.topicStatus,
    });
    if (input.keyword) params.set("keyword", input.keyword);
    // API accepts comma-separated component values
    if (input.component && input.component.length > 0) {
      params.set("component", input.component.join(","));
    }

    const url = `${BASE}/topics?${params.toString()}`;
    const res = await ctx.fetch(url, {
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SBIR API → ${res.status}: ${text}`);
    }

    const raw = (await res.json()) as RawSbirPage;
    const rawTopics = raw.content ?? [];

    const topics: SbirTopic[] = rawTopics.map((t) => {
      const topicNumber = t.topicNumber ?? "";
      return {
        topicId: t.topicId ?? 0,
        topicNumber,
        title: t.title ?? "",
        program: t.program ?? "SBIR",
        phase: t.phase ?? "",
        agency: t.agency ?? null,
        component: t.component ?? null,
        solicitationTitle: t.solicitationTitle ?? t.solicitationNumber ?? null,
        openDate: t.openDate ?? null,
        closeDate: t.closeDate ?? null,
        topicStatus: t.topicStatus ?? input.topicStatus,
        abstract: (t.abstract ?? t.description ?? null)?.slice(0, 800) ?? null,
        sourceUrl: topicNumber
          ? `https://dodsbirsttr.mil/topics-app/?topiccode=${topicNumber}`
          : "https://dodsbirsttr.mil/topics-app/",
      };
    });

    return {
      totalElements: raw.totalElements ?? topics.length,
      topics,
    };
  },
});
