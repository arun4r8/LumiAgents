import { z } from "zod";
import { defineOrchestration } from "@/runtime";
import type { Env } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { escapeHtml as esc, fmtDate } from "@/runtime/utils/format";
import {
  runSubscriptionDigest,
  renderDigestShell,
  digestKv,
  type DigestSubscription,
} from "@/runtime/utils/subscription-digest";

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const inputSchema = z.object({
  subscriptionId: z
    .string()
    .uuid()
    .optional()
    .describe("Manual trigger: send this subscription now, ignoring cadence."),
});

export const outputSchema = z.object({
  subscriptionsDue: z.number(),
  emailsSent:       z.number(),
  emailsSkipped:    z.number(),
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface AwardSubscription extends DigestSubscription {
  award_types:  string[] | null;
  min_fit_score: number;
  // eligibility profile (award-kind subs) — used to filter to what the subscriber qualifies for
  held_set_asides:    string[] | null;
  ownership:          string[] | null;
  annual_revenue_usd: number | null;
  founded_year:       number | null;
}

interface Award {
  title:                string;
  sponsor:              string | null;
  category:             string | null;
  award_type:           string;
  application_deadline: string | null;
  nomination_deadline:  string | null;
  source_url:           string | null;
  fit_score:            number;
  fit_reason:           string | null;
  prestige:             string | null;
  effort:               string | null;
  recommendation:       string;
  cycle_status:         string | null;
  // extracted eligibility REQUIREMENTS
  set_aside_required:   string | null;
  owner_required:       string | null;
  revenue_cap_usd:      number | null;
  applicant_type:       string | null;
  min_years:            number | null;
  max_years:            number | null;
  last_scored_at:       string | null;
}

const SUB_COLS =
  "id,label,cadence,recipients,award_types,min_fit_score,held_set_asides,ownership,annual_revenue_usd,founded_year,last_sent_at";

const MAX_DIGEST = 30;

// Match an award's extracted eligibility REQUIREMENTS against a subscription's
// eligibility PROFILE. Default to INCLUDE: an award is only excluded when it is KNOWN
// to fail a dimension. Unknown/permissive requirement values ("none"/"other"/null) and
// blank profile fields never exclude.
function eligibleForSub(award: Award, sub: AwardSubscription, currentYear: number): boolean {
  // Set-aside: a required certification the subscriber doesn't hold → exclude.
  const sa = award.set_aside_required;
  if (sa && sa !== "none" && sa !== "other" && !(sub.held_set_asides?.includes(sa) ?? false)) {
    return false;
  }
  // Ownership: a required ownership status the subscriber doesn't have → exclude.
  const ow = award.owner_required;
  if (ow && ow !== "none" && ow !== "other" && !(sub.ownership?.includes(ow) ?? false)) {
    return false;
  }
  // Revenue: subscriber over the award's revenue cap → exclude.
  if (
    award.revenue_cap_usd != null &&
    sub.annual_revenue_usd != null &&
    sub.annual_revenue_usd > award.revenue_cap_usd
  ) {
    return false;
  }
  // Applicant type: fed-employee awards can't be won by a contractor company → exclude.
  if (award.applicant_type === "federal_employee") return false;
  // Company age: outside the award's specified age bounds → exclude.
  if (sub.founded_year != null) {
    const age = currentYear - sub.founded_year;
    if (award.min_years != null && age < award.min_years) return false;
    if (award.max_years != null && age > award.max_years) return false;
  }
  return true;
}

// ─── Digest query ──────────────────────────────────────────────────────────────

async function loadDigestAwards(
  env: Env,
  sub: AwardSubscription,
  opts: { sinceLastSent: boolean },
): Promise<Award[]> {
  const params = new URLSearchParams({
    select: "title,sponsor,category,award_type,application_deadline,nomination_deadline,source_url,fit_score,fit_reason,prestige,effort,recommendation,cycle_status,set_aside_required,owner_required,revenue_cap_usd,applicant_type,min_years,max_years,last_scored_at",
    fit_score:     `gte.${sub.min_fit_score}`,
    recommendation: "neq.skip",
    order: "fit_score.desc,last_scored_at.desc",
    limit: "200",
  });

  if (opts.sinceLastSent && sub.last_sent_at) {
    params.append("last_scored_at", `gt.${sub.last_sent_at}`);
  }
  if (sub.award_types?.length) {
    params.append("award_type", `in.(${sub.award_types.join(",")})`);
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/awards?${params.toString()}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error(`load awards → ${res.status}: ${await res.text()}`);

  const currentYear = new Date().getFullYear();
  const rows = (await res.json()) as Award[];
  return rows
    // Never email an expired cycle (null cycle_status is kept — only known-closed drops).
    .filter((a) => a.cycle_status !== "closed")
    // Filter to what this subscription is eligible for (default include on unknowns).
    .filter((a) => eligibleForSub(a, sub, currentYear))
    .slice(0, MAX_DIGEST);
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

function prestigeBadge(prestige: string | null): string {
  if (!prestige) return "";
  const styles: Record<string, string> = {
    high:   "background:#fef3c7;color:#92400e",
    medium: "background:#e0e7ff;color:#3730a3",
    low:    "background:#f3f4f6;color:#6b7280",
  };
  const style = styles[prestige] ?? styles["low"] ?? "background:#f3f4f6;color:#6b7280";
  return `<span style="display:inline-block;${style};border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-right:4px;">${esc(prestige)} prestige</span>`;
}

function effortBadge(effort: string | null): string {
  if (!effort) return "";
  const styles: Record<string, string> = {
    low:    "background:#dcfce7;color:#166534",
    medium: "background:#fef9c3;color:#854d0e",
    high:   "background:#fee2e2;color:#991b1b",
  };
  const style = styles[effort] ?? styles["medium"] ?? "background:#fef9c3;color:#854d0e";
  return `<span style="display:inline-block;${style};border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;">${esc(effort)} effort</span>`;
}

function recColor(rec: string): { bg: string; fg: string } {
  if (rec === "apply")   return { bg: "#dcfce7", fg: "#166534" };
  if (rec === "consider") return { bg: "#fef9c3", fg: "#854d0e" };
  return { bg: "#f3f4f6", fg: "#374151" };
}

function renderEmail(
  sub: AwardSubscription,
  awards: Award[],
  opts: { manual: boolean },
): { subject: string; html: string } {
  const heading   = opts.manual ? "Matching award opportunities" : "New award opportunities";
  const adj       = opts.manual ? "" : "new ";
  const subject   = `Cleo Awards: ${awards.length} ${adj}${awards.length === 1 ? "opportunity" : "opportunities"} (fit ≥ ${sub.min_fit_score})`;

  const filterBits = [`fit ≥ ${sub.min_fit_score}`];
  if (sub.award_types?.length) filterBits.push(sub.award_types.join(" / "));

  const cards = awards
    .map((a) => {
      const c         = recColor(a.recommendation);
      const titleHtml = a.source_url
        ? `<a href="${esc(a.source_url)}" style="color:#2563eb;text-decoration:none;">${esc(a.title)}</a>`
        : esc(a.title);
      const typeLabel = a.award_type === "government" ? "GOVERNMENT" : "INDUSTRY";
      const typeBg    = a.award_type === "government" ? "#e0e7ff" : "#f0fdf4";
      const typeFg    = a.award_type === "government" ? "#3730a3" : "#166534";
      const deadline  = a.application_deadline ?? a.nomination_deadline;

      return `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:12px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:8px;"><tr>
          <td style="vertical-align:top;">
            <span style="display:inline-block;background:${typeBg};color:${typeFg};border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;letter-spacing:.03em;">${typeLabel}</span>
          </td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;">
            <span style="display:inline-block;background:${c.bg};color:${c.fg};border-radius:9999px;padding:2px 10px;font-weight:700;font-size:14px;">${a.fit_score}</span>
            <span style="color:#6b7280;font-size:11px;text-transform:capitalize;margin-left:6px;">${esc(a.recommendation)}</span>
          </td>
        </tr></table>
        <div style="font-size:16px;font-weight:700;line-height:1.3;margin-bottom:2px;color:#111827;">${titleHtml}</div>
        ${a.category ? `<div style="color:#6b7280;font-size:12px;margin-bottom:6px;">${esc(a.category)}</div>` : ""}
        <div style="color:#6b7280;font-size:13px;line-height:1.5;margin-bottom:12px;">${esc(a.fit_reason ?? "")}</div>
        <div style="margin-bottom:10px;">${prestigeBadge(a.prestige)}${effortBadge(a.effort)}</div>
        <table role="presentation" style="border-collapse:collapse;margin-bottom:10px;">
          ${digestKv("Sponsor", esc(a.sponsor ?? "-"))}
          ${digestKv("Deadline", fmtDate(deadline))}
        </table>
        ${a.source_url ? `<a href="${esc(a.source_url)}" style="color:#2563eb;text-decoration:none;font-size:13px;font-weight:600;">View award &rarr;</a>` : ""}
      </div>`;
    })
    .join("");

  const html = renderDigestShell({
    heading,
    label: sub.label ?? "Award report",
    cadence: sub.cadence,
    filterBits,
    cards,
    footer: "Filtered to this subscription's eligibility profile. Sent by Cleo · manage this report from the LumiAgents dashboard &rarr; Awards.",
  });

  return { subject, html };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "cleo/award-report",
  version: 1,
  description:
    "Email award digest to subscribers (industry recognition + government small business awards). Driven by a daily meta-cron; each subscription's cadence is honored.",
  cron: "0 14 * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    return runSubscriptionDigest<AwardSubscription, Award>(ctx, input, {
      kind: "award",
      subColumns: SUB_COLS,
      sender: "cleo",
      stepPrefix: "award-report",
      emptyReasonManual: "no-matching-awards",
      emptyReasonCron: "no-new-awards",
      loadRecords: loadDigestAwards,
      renderEmail,
    });
  },
});
