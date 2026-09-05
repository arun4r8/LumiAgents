import Anthropic from "@anthropic-ai/sdk";
import { anthropicClient } from "./client";
import type { Env } from "../../runtime/src/types";
import { MODELS } from "../../runtime/src/config/models";

// Cleo's content drafter for the eminence calendar. Two modes:
//   draftContentPost: turn one calendar row into a submission-ready LinkedIn post
//     (copy + asset brief), grounded ONLY in the real company profile.
//   planContentIdeas: propose a run of post ideas from a theme.
// Never invents facts about Lumiture (contracts, awards, numbers) that aren't in the
// profile; eminence content is the company's public voice.

const DEFAULT_MODEL: string = MODELS.sonnet;

function firstText(resp: Anthropic.Message): string {
  const b = resp.content.find((x) => x.type === "text");
  return b && b.type === "text" ? b.text : "";
}

export type ContentChannel = "linkedin" | "instagram";

// LinkedIn: long-form thought-leadership. Instagram: visual-first captions. Same grounding
// rules; the channel only changes the copy format so Cleo can draft for either surface
// (Tier 0 #67 — "make Cleo draft Instagram content instead of LinkedIn").
const CHANNEL_COPY_SPEC: Record<ContentChannel, string> = {
  linkedin:
    `The ready-to-publish LinkedIn post. Strong first-line hook, 2–4 short paragraphs, a clear takeaway, and a light CTA. Professional but human; no hashtag stuffing. 1–3 relevant hashtags at the end.`,
  instagram:
    `The ready-to-publish Instagram caption. A strong hook line, then 3–6 short lines (visual-first, scannable), one clear CTA, and 3–8 relevant hashtags at the end. Never LinkedIn-style long-form paragraphs.`,
};

function postSystemPrompt(channel: ContentChannel): string {
  const label = channel === "instagram" ? "Instagram" : "LinkedIn";
  return `You are Cleo, Lumiture's eminence and brand-voice assistant. Draft a single ${label} post for Lumiture, LLC from the provided calendar entry.

Output Markdown with exactly these sections:
## Post copy
${CHANNEL_COPY_SPEC[channel]}
## Asset brief
2–4 sentences describing the visual to accompany the post (what the graphic/carousel/video should show), consistent with the asset_ref/asset_type if given.
## Notes
Anything the human should confirm before posting (e.g. a claim to verify, a tag to add).

Rules:
- Ground any claim about Lumiture ONLY in the provided company profile. Never invent contracts, clients, awards, certifications, or metrics.
- If the entry's description is thin, expand on the topic sensibly but do not fabricate company specifics; use a clearly-marked placeholder like [confirm: specific example].
- Match a confident, credible, non-salesy government-technology brand voice.
- Do not use em dashes.`;
}

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
  /** Which social channel to draft for. Defaults to LinkedIn (backward compatible). */
  channel?: ContentChannel;
}

export async function draftContentPost(env: Env, input: ContentPostInput, model = DEFAULT_MODEL): Promise<string> {
  const channel: ContentChannel = input.channel ?? "linkedin";
  const label = channel === "instagram" ? "Instagram" : "LinkedIn";
  const client = anthropicClient(env.ANTHROPIC_API_KEY);
  const payload = { calendar_entry: input.entry, company_profile: input.companyProfile };
  const resp = await client.messages.create({
    model,
    max_tokens: 1600,
    system: postSystemPrompt(channel),
    messages: [{
      role: "user",
      content: `Draft the ${label} post using only this data:\n\n<data>\n${JSON.stringify(payload, null, 2)}\n</data>`,
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
  const client = anthropicClient(env.ANTHROPIC_API_KEY);
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
