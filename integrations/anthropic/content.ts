import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../runtime/src/types";

// Cleo's content drafter for the eminence calendar. Two modes:
//   draftContentPost: turn one calendar row into a submission-ready LinkedIn post
//     (copy + asset brief), grounded ONLY in the real company profile.
//   planContentIdeas: propose a run of post ideas from a theme.
// Never invents facts about Lumiture (contracts, awards, numbers) that aren't in the
// profile; eminence content is the company's public voice.

const DEFAULT_MODEL = "claude-sonnet-4-6";

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

const POST_SYSTEM = `You are Cleo, Lumiture's eminence and brand-voice assistant. Draft a single LinkedIn post for Lumiture, LLC from the provided calendar entry.

Output Markdown with exactly these sections:
## Post copy
The ready-to-publish post. Strong first-line hook, 2–4 short paragraphs, a clear takeaway, and a light CTA. Professional but human; no hashtag stuffing. 1–3 relevant hashtags at the end.
## Asset brief
2–4 sentences describing the visual to accompany the post (what the graphic/carousel/video should show), consistent with the asset_ref/asset_type if given.
## Notes
Anything the human should confirm before posting (e.g. a claim to verify, a tag to add).

Rules:
- Ground any claim about Lumiture ONLY in the provided company profile. Never invent contracts, clients, awards, certifications, or metrics.
- If the entry's description is thin, expand on the topic sensibly but do not fabricate company specifics; use a clearly-marked placeholder like [confirm: specific example].
- Match a confident, credible, non-salesy government-technology brand voice.
- Do not use em dashes.`;

const PLAN_SYSTEM = `You are Cleo, Lumiture's eminence strategist. Propose a run of LinkedIn post IDEAS for Lumiture, LLC on the given theme.

Return ONLY a JSON array (no prose) of objects with keys:
  "topic":       short post title (<= 80 chars)
  "description": 1–2 sentence brief of what the post covers and its angle
  "asset_type":  one of: graphic | carousel | video | text

Rules:
- Ideas must be relevant to Lumiture's actual capabilities per the provided profile; do not invent specifics.
- Vary the angles (thought leadership, team/culture, capability spotlight, industry commentary).
- Return exactly the requested number of ideas.
- Do not use em dashes.`;

export interface ContentPostInput {
  entry: Record<string, unknown>;
  companyProfile: unknown;
}

export async function draftContentPost(env: Env, input: ContentPostInput, model = DEFAULT_MODEL): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const payload = { calendar_entry: input.entry, company_profile: input.companyProfile };
  const resp = await client.messages.create({
    model,
    max_tokens: 1600,
    system: POST_SYSTEM,
    messages: [{
      role: "user",
      content: `Draft the LinkedIn post using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`,
    }],
  });
  return firstText(resp) || "Content draft generation failed.";
}

export interface ContentIdea {
  topic: string;
  description: string;
  asset_type: string;
}

export async function planContentIdeas(
  env: Env,
  opts: { theme: string; count: number; companyProfile: unknown },
  model = DEFAULT_MODEL,
): Promise<ContentIdea[]> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const payload = { theme: opts.theme, count: opts.count, company_profile: opts.companyProfile };
  const resp = await client.messages.create({
    model,
    max_tokens: 1500,
    system: PLAN_SYSTEM,
    messages: [{
      role: "user",
      content: `Propose exactly ${opts.count} post ideas as a JSON array, using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`,
    }],
  });
  const text = firstText(resp);
  try {
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : text) as ContentIdea[];
    return parsed
      .filter((p) => p && typeof p.topic === "string")
      .map((p) => ({ topic: p.topic, description: p.description ?? "", asset_type: p.asset_type ?? "graphic" }));
  } catch {
    return [];
  }
}
