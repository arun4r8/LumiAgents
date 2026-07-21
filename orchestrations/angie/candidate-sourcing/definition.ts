import { z } from "zod";
import { defineOrchestration, step, llm_extract, await_approval } from "@/runtime";
import { apolloPeopleSearch } from "./tools";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  jobTitle: z.string().describe("Title of the role being hired for (e.g. 'Senior Database Engineer')"),
  jobDescription: z.string().min(50).describe("Full job description or requirements summary"),
  location: z
    .string()
    .optional()
    .describe("Preferred location (e.g. 'United States', 'Remote', 'Washington DC'). Defaults to US."),
  maxCandidates: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Max candidates to surface from Apollo (each revealed email costs 1 credit)"),
  requireClearance: z
    .boolean()
    .default(false)
    .describe("Whether to keyword-search for security clearance holders"),
});

const shortlistedCandidateSchema = z.object({
  apolloId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  location: z.string().nullable().describe("City, State / Country"),
  seniority: z.string().nullable(),
  matchScore: z.number().int().min(1).max(10).describe("1-10 fit score against the job description"),
  matchReason: z.string().describe("1-2 sentence rationale for the score"),
  outreachDraft: z.string().nullable().describe("Draft outreach message. Null until approved."),
});

export const outputSchema = z.object({
  totalFound: z.number().describe("Total candidates Apollo returned for the search"),
  shortlistCount: z.number().describe("Candidates that passed Angie's fit filter"),
  candidates: z.array(shortlistedCandidateSchema),
  approvalDecision: z.enum(["approved", "rejected", "expired"]),
  approvedBy: z.string().nullable(),
});

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "angie/candidate-sourcing",
  version: 1,
  description:
    "Source candidates for a role via Apollo.io: extracts search params, filters by fit, surfaces a shortlist, and drafts outreach on approval",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    // ── Step 1: Translate job description → Apollo search parameters ──────────
    const searchParams = await llm_extract(ctx, {
      name: "extract-apollo-search-params",
      prompt: `
You are an expert technical recruiter. Given the job title and description below,
produce the best Apollo.io people-search parameters to find strong candidates.

Rules:
- titles: include 2-5 variations of the role (e.g. DBA, Database Administrator, Database Engineer)
- keywords: emphasise the specific technologies/stack mentioned (e.g. "PostgreSQL Oracle AWS")
- seniorities: infer from the description ("senior" / "lead" → senior, director; "junior" / "associate" → entry, junior, mid)
- locations: derive from the input location; if unclear default to ["United States"]
- If the role is government-contract-related, add "cleared" or "security clearance" to keywords

Return ONLY the structured parameters. Do not include explanations.
      `.trim(),
      input: {
        jobTitle: input.jobTitle,
        jobDescription: input.jobDescription,
        location: input.location ?? "United States",
        requireClearance: input.requireClearance,
      },
      schema: z.object({
        titles: z.array(z.string()).min(1).max(6),
        keywords: z.string().optional(),
        locations: z.array(z.string()).min(1),
        seniorities: z.array(
          z.enum(["entry", "junior", "mid", "senior", "manager", "director", "vp", "c_suite", "partner", "owner"]),
        ),
      }),
    });

    // ── Step 2: Search Apollo ─────────────────────────────────────────────────
    const searchResults = await step(ctx, "apollo-people-search", () =>
      apolloPeopleSearch(ctx, {
        titles: searchParams.titles,
        ...(searchParams.keywords !== undefined ? { keywords: searchParams.keywords } : {}),
        locations: searchParams.locations,
        seniorities: searchParams.seniorities,
        perPage: input.maxCandidates,
        page: 1,
      }),
    );

    if (searchResults.people.length === 0) {
      // Nothing found, so return early without consuming an approval
      return {
        totalFound: 0,
        shortlistCount: 0,
        candidates: [],
        approvalDecision: "rejected",
        approvedBy: null,
      };
    }

    // ── Step 3: Score and filter candidates by fit ────────────────────────────
    const shortlisted = await llm_extract(ctx, {
      name: "score-and-filter-candidates",
      prompt: `
You are Angie, Lumiture's AI recruiter. Lumiture is a database management and AI solutions company
working primarily on US government contracts.

Score each candidate against the job requirements. Only include candidates scoring 6 or higher.
Write a short matchReason (1-2 sentences) explaining the fit.

Do NOT generate outreachDraft yet. Set it to null for all candidates.
      `.trim(),
      input: {
        jobTitle: input.jobTitle,
        jobDescription: input.jobDescription,
        candidates: searchResults.people.map((p) => ({
          apolloId: p.apolloId,
          name: p.name,
          title: p.title,
          company: p.company,
          email: p.email,
          linkedinUrl: p.linkedinUrl,
          location: [p.city, p.state, p.country].filter(Boolean).join(", ") || null,
          seniority: p.seniority,
        })),
      },
      schema: z.object({
        shortlisted: z.array(
          z.object({
            apolloId: z.string(),
            name: z.string(),
            title: z.string().nullable(),
            company: z.string().nullable(),
            email: z.string().nullable(),
            linkedinUrl: z.string().nullable(),
            location: z.string().nullable(),
            seniority: z.string().nullable(),
            matchScore: z.number().int().min(1).max(10),
            matchReason: z.string(),
          }),
        ),
      }),
    });

    // ── Step 4: Upsert shortlisted candidates into Supabase ───────────────────
    await step(ctx, "upsert-candidates", async () => {
      const rows = shortlisted.shortlisted.map((c) => ({
        apollo_id: c.apolloId,
        name: c.name,
        email: c.email,
        linkedin_url: c.linkedinUrl,
        current_title: c.title,
        current_company: c.company,
        source: "apollo",
        source_run_id: ctx.runId,
      }));

      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/candidates?on_conflict=apollo_id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": ctx.env.SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": `Bearer ${ctx.env.SUPABASE_SERVICE_ROLE_KEY}`,
            "Prefer": "resolution=merge-duplicates",
          },
          body: JSON.stringify(rows),
        },
      );

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase upsert candidates → ${res.status}: ${text}`);
      }
    });

    // ── Step 5: Pause for human approval before drafting outreach ─────────────
    const approvalPromptLines = shortlisted.shortlisted.map(
      (c, i) =>
        `${i + 1}. ${c.name}: ${c.title ?? "Unknown title"} @ ${c.company ?? "Unknown"} (score: ${c.matchScore}/10)\n   ${c.matchReason}`,
    );

    const approval = await await_approval(ctx, {
      name: "approve-outreach-drafts",
      prompt: `
Angie found ${shortlisted.shortlisted.length} candidate${shortlisted.shortlisted.length === 1 ? "" : "s"} for "${input.jobTitle}".

${approvalPromptLines.join("\n\n")}

Approve to have Angie draft personalised outreach messages for each candidate.
Reject if the shortlist needs reworking.
      `.trim(),
      from: { role: "hr" },
      expiresInHours: 48,
    });

    if (!approval.approved) {
      return {
        totalFound: searchResults.totalResults,
        shortlistCount: shortlisted.shortlisted.length,
        candidates: shortlisted.shortlisted.map((c) => ({ ...c, outreachDraft: null })),
        approvalDecision: "rejected",
        approvedBy: approval.decidedBy,
      };
    }

    // ── Step 6: Draft personalised outreach messages ───────────────────────────
    const withDrafts = await llm_extract(ctx, {
      name: "draft-outreach-messages",
      prompt: `
You are Angie, Lumiture's AI recruiter. Write a short, warm, personalised LinkedIn or email
outreach message for each candidate below.

Guidelines:
- 3-4 sentences max
- Mention something specific about their background (title, company)
- Briefly describe the opportunity and why it fits them
- End with a soft call-to-action ("Would you be open to a quick conversation?")
- Do NOT mention salary or compensation
- Tone: professional but conversational, not corporate-stiff
- Do not use em dashes.
- Sign as "Angie, Lumiture Recruiting"
      `.trim(),
      input: {
        jobTitle: input.jobTitle,
        companyBlurb: "Lumiture is a database management and AI solutions company focused on US government contracts.",
        candidates: shortlisted.shortlisted,
      },
      schema: z.object({
        drafts: z.array(
          z.object({
            apolloId: z.string(),
            outreachDraft: z.string(),
          }),
        ),
      }),
    });

    // Merge drafts back into the candidate list
    const draftMap = new Map(withDrafts.drafts.map((d) => [d.apolloId, d.outreachDraft]));
    const candidatesWithDrafts = shortlisted.shortlisted.map((c) => ({
      ...c,
      outreachDraft: draftMap.get(c.apolloId) ?? null,
    }));

    return {
      totalFound: searchResults.totalResults,
      shortlistCount: candidatesWithDrafts.length,
      candidates: candidatesWithDrafts,
      approvalDecision: "approved",
      approvedBy: approval.decidedBy,
    };
  },
});
