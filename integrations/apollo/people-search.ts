import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callApollo } from "./base";

// ─── Input / output schemas ───────────────────────────────────────────────────

export const apolloPeopleSearchInputSchema = z.object({
  titles: z
    .array(z.string())
    .min(1)
    .describe("Job titles to match (e.g. ['Database Administrator', 'DBA', 'Database Engineer'])"),
  keywords: z
    .string()
    .optional()
    .describe("Free-text keyword search (skills, tech stack, etc.)"),
  locations: z
    .array(z.string())
    .optional()
    .describe("Locations to filter by (e.g. ['United States', 'Remote'])"),
  seniorities: z
    .array(z.enum(["entry", "junior", "mid", "senior", "manager", "director", "vp", "c_suite", "partner", "owner"]))
    .optional()
    .describe("Seniority levels to include"),
  perPage: z.number().int().min(1).max(25).default(10).describe("Results per page (max 25 on free tier)"),
  page: z.number().int().min(1).default(1),
});

export const apolloPersonSchema = z.object({
  apolloId: z.string(),
  name: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  email: z.string().nullable().describe("Revealed email — costs 1 credit. Null if not available."),
  linkedinUrl: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  country: z.string().nullable(),
  seniority: z.string().nullable(),
});

export const apolloPeopleSearchOutputSchema = z.object({
  people: z.array(apolloPersonSchema),
  totalResults: z.number(),
  page: z.number(),
  perPage: z.number(),
});

export type ApolloPerson = z.infer<typeof apolloPersonSchema>;

// ─── Raw Apollo response shape (internal — not exported) ─────────────────────

interface RawApolloPerson {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  title?: string;
  organization_name?: string;
  email?: string;
  linkedin_url?: string;
  city?: string;
  state?: string;
  country?: string;
  seniority?: string;
}

interface RawApolloSearchResponse {
  people?: RawApolloPerson[];
  pagination?: {
    page?: number;
    per_page?: number;
    total_entries?: number;
  };
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const apolloPeopleSearch = defineTool({
  name: "apolloPeopleSearch",
  inputSchema: apolloPeopleSearchInputSchema,
  outputSchema: apolloPeopleSearchOutputSchema,
  async run(ctx, input) {
    const body: Record<string, unknown> = {
      person_titles: input.titles,
      per_page: input.perPage,
      page: input.page,
    };

    if (input.keywords) body["q_keywords"] = input.keywords;
    if (input.locations && input.locations.length > 0) body["person_locations"] = input.locations;
    if (input.seniorities && input.seniorities.length > 0) body["person_seniorities"] = input.seniorities;

    const raw = await callApollo<RawApolloSearchResponse>(ctx, "mixed_people/search", body);

    const people: ApolloPerson[] = (raw.people ?? []).map((p) => ({
      apolloId: p.id ?? "",
      name: p.name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      firstName: p.first_name ?? "",
      lastName: p.last_name ?? "",
      title: p.title ?? null,
      company: p.organization_name ?? null,
      email: p.email ?? null,
      linkedinUrl: p.linkedin_url ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      country: p.country ?? null,
      seniority: p.seniority ?? null,
    }));

    return {
      people,
      totalResults: raw.pagination?.total_entries ?? people.length,
      page: raw.pagination?.page ?? input.page,
      perPage: raw.pagination?.per_page ?? input.perPage,
    };
  },
});
