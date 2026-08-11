import { defineOrchestration, llm_extract, step } from "@/runtime";
import { z } from "zod";

/**
 * Blind resume export (#156).
 *
 * Produces a client-submission copy of a resume with the candidate's identity
 * removed, so a client evaluates the experience before the person.
 *
 * The design point worth understanding before changing anything here: an LLM
 * redaction pass alone is not trustworthy. It will confidently report success
 * while leaving a first name in a bullet ("led John's team through...") or an
 * address in a footer. So the model does the rewriting, and then a
 * deterministic pass VERIFIES the result and scrubs whatever survived. The
 * model proposes; plain string matching disposes.
 *
 * This deliberately does not redact employer names. Some blind formats do
 * ("a Fortune 500 retailer"), but it is a much harder problem and it strips out
 * most of what makes the document persuasive. If that is wanted it should be an
 * explicit, separately-reviewed option.
 */

const inputSchema = z.object({
  // Either is enough. Text is the ordinary path; the PDF exists because resumes
  // arrive as PDFs and nothing in the runtime can extract their text (pdf-lib
  // creates PDFs, it does not parse them), so the model reads the file directly.
  resume_text: z.string().default("").describe("Raw resume text to redact. Omit when supplying resume_pdf_base64."),
  resume_pdf_base64: z
    .string()
    .optional()
    .describe("Base64 PDF of the resume, read directly by the model. Supplied automatically when a PDF is attached in chat."),
  candidate_code: z
    .string()
    .optional()
    .describe(
      "Optional non-identifying label to print in place of the name, e.g. 'LUM-0042', so a submission can be traced back internally. Omit for a fully anonymous document.",
    ),
});

/** What the model believes identifies this person. Drives the deterministic sweep. */
const identifiersSchema = z.object({
  full_name: z.string().describe("The candidate's full name exactly as written"),
  name_variants: z
    .array(z.string())
    .describe(
      "Every other way this person is named anywhere in the document: first name alone, surname alone, initials, nicknames, possessive forms without the apostrophe. This list is what the verification pass hunts for, so be exhaustive rather than tidy.",
    ),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  urls: z
    .array(z.string())
    .describe("Personal URLs: LinkedIn, GitHub, portfolio sites. Not employer or client sites."),
  addresses: z
    .array(z.string())
    .describe("Street addresses and any city/state line used as personal contact detail"),
  other: z
    .array(z.string())
    .describe("Anything else identifying: personal references and their contact details, visa or ID numbers, dates of birth"),
});

const redactedSchema = z.object({
  redacted_resume: z
    .string()
    .describe("The full resume with every identifying detail removed, same structure and content otherwise"),
  notes: z.array(z.string()).describe("What was removed or reworded, one line each"),
});

const outputSchema = z.object({
  redacted_resume: z.string().describe("Redaction-verified resume text, ready to render on letterhead"),
  removed: z.array(z.string()).describe("Human-readable summary of what was stripped"),
  verified_clean: z
    .boolean()
    .describe("True when the deterministic sweep found no identifying data left in the output"),
  residual_findings: z
    .array(z.string())
    .describe("Anything the sweep caught after the model's pass. Empty is the expected result; non-empty means the model missed something and the scrub caught it."),
});

// ─── Deterministic verification ───────────────────────────────────────────────

/** Patterns that identify a person regardless of what the model reported. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Deliberately loose: 10+ digits with common separators. Over-matching here is
// safe (worst case we redact a phone-shaped number), under-matching is not.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const PERSONAL_URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|github\.com|gitlab\.com|medium\.com|substack\.com|behance\.net|dribbble\.com)\/\S+/gi;

/** Escape a literal so it can be used inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan text for anything identifying and return one finding per hit.
 * `literals` are the model-reported identifiers; the regexes catch what it missed.
 */
export function findIdentifying(text: string, literals: string[]): string[] {
  const findings: string[] = [];

  for (const raw of literals) {
    const lit = raw.trim();
    // Single characters and very short fragments match everywhere and would make
    // the sweep useless. Initials are handled by the name-variant list instead.
    if (lit.length < 3) continue;
    const re = new RegExp(`\\b${escapeRe(lit)}`, "gi");
    const hits = text.match(re);
    if (hits) findings.push(`literal "${lit}" appears ${hits.length}x`);
  }

  for (const [label, re] of [
    ["email", EMAIL_RE],
    ["phone", PHONE_RE],
    ["personal URL", PERSONAL_URL_RE],
  ] as const) {
    const hits = text.match(re);
    if (hits) findings.push(`${label}: ${[...new Set(hits)].join(", ")}`);
  }

  return findings;
}

/**
 * Remove anything the sweep can identify. Runs only on what the model left
 * behind, so in the normal case it changes nothing.
 */
export function scrub(text: string, literals: string[]): string {
  let out = text;
  for (const raw of literals) {
    const lit = raw.trim();
    if (lit.length < 3) continue;
    out = out.replace(new RegExp(`\\b${escapeRe(lit)}('s)?`, "gi"), "the candidate");
  }
  out = out.replace(EMAIL_RE, "[redacted]");
  out = out.replace(PERSONAL_URL_RE, "[redacted]");
  out = out.replace(PHONE_RE, "[redacted]");
  return out;
}

export default defineOrchestration({
  name: "angie/resume-redact",
  version: 1,
  description:
    "Produce a blind (client-submission) copy of a resume: strips the candidate's name, contact details and personal links, verifies the result deterministically, and returns text ready to render on Lumiture letterhead.",
  triggerMode: "agent",
  readOnly: true,
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops", "role:hr"],
    visibleTo: ["role:ops", "role:hr"],
  },

  async run(ctx, input) {
    const pdf = input.resume_pdf_base64
      ? [{ base64: input.resume_pdf_base64, mediaType: "application/pdf" }]
      : undefined;

    if (!input.resume_text.trim() && !pdf) {
      throw new Error(
        "Supply either resume_text or resume_pdf_base64. Neither was provided, " +
          "so there is nothing to redact.",
      );
    }

    const identifiers = await llm_extract(ctx, {
      name: "find-identifiers",
      prompt:
        `Find every detail in this resume that identifies the person. Do not rewrite anything yet.\n\n` +
        `Be exhaustive about name_variants in particular. A later pass searches the output for each ` +
        `string you list, so a first name you forget to mention is a first name that survives into a ` +
        `document we send to a client. Include the first name on its own, the surname on its own, any ` +
        `shortened or informal form, and the possessive stem (for "John's", list "John").\n\n` +
        `Return empty arrays for categories that genuinely do not appear.`,
      input: { resume_text: input.resume_text || "(supplied as an attached PDF)" },
      ...(pdf ? { documents: pdf } : {}),
      schema: identifiersSchema,
    });

    const literals = [
      identifiers.full_name,
      ...identifiers.name_variants,
      ...identifiers.emails,
      ...identifiers.phones,
      ...identifiers.urls,
      ...identifiers.addresses,
      ...identifiers.other,
    ].filter((s) => typeof s === "string" && s.trim().length > 0);

    const redacted = await llm_extract(ctx, {
      name: "redact-resume",
      prompt:
        `Rewrite the resume with every identifying detail removed. Rules:\n\n` +
        `1. Remove the contact block entirely: name, email, phone, address, personal links.\n` +
        `2. Where the person is referred to by name in body text, rewrite the sentence so it reads ` +
        `naturally without the name. Prefer rephrasing over substituting a placeholder.\n` +
        `3. Keep everything else exactly as it is. Same positions, same employers, same dates, same ` +
        `bullets, same numbers. This is a redaction, not a rewrite, and inventing or dropping ` +
        `experience makes the document useless.\n` +
        `4. Keep employer and client names. They are not being redacted.\n` +
        `5. Remove any references section along with referee names and their contact details.\n` +
        `6. Use the same section headers the original used.\n` +
        `7. Do not use em dashes.\n\n` +
        (input.candidate_code
          ? `Open the document with the line "Candidate ${input.candidate_code}" in place of the name.\n`
          : `Do not add any replacement label where the name was.\n`),
      input: {
        resume_text: input.resume_text || "(supplied as an attached PDF)",
        identifiers_to_remove: identifiers,
      },
      ...(pdf ? { documents: pdf } : {}),
      schema: redactedSchema,
    });

    // The part that makes this trustworthy. Everything above is the model's word
    // for it; this is a plain string sweep of what it actually produced.
    const verification = await step(ctx, "verify-redaction", async () => {
      const findings = findIdentifying(redacted.redacted_resume, literals);
      if (findings.length === 0) {
        return { text: redacted.redacted_resume, findings, scrubbed: false };
      }
      // The model missed something. Scrub deterministically and re-check, so the
      // document is safe to send even on the model's bad day.
      const scrubbed = scrub(redacted.redacted_resume, literals);
      return { text: scrubbed, findings, scrubbed: true, after: findIdentifying(scrubbed, literals) };
    });

    const residual = verification.scrubbed
      ? [
          ...verification.findings.map((f) => `model left: ${f}`),
          ...((verification.after ?? []).map((f) => `SURVIVED SCRUB: ${f}`)),
        ]
      : [];

    return {
      redacted_resume: verification.text,
      removed: redacted.notes,
      verified_clean: (verification.after ?? verification.findings).length === 0,
      residual_findings: residual,
    };
  },
});
