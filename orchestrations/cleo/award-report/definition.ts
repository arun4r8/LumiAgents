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
  last_scored_at:       string | null;
}

const SUB_COLS = "id,label,cadence,recipients,award_types,min_fit_score,last_sent_at";

const MAX_DIGEST = 30;

// ─── Digest query ──────────────────────────────────────────────────────────────

async function loadDigestAwards(
  env: Env,
  sub: AwardSubscription,
  opts: { sinceLastSent: boolean },
): Promise<Award[]> {
  const params = new URLSearchParams({
    select: "title,sponsor,category,award_type,application_deadline,nomination_deadline,source_url,fit_score,fit_reason,prestige,effort,recommendation,last_scored_at",
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
  return ((await res.json()) as Award[]).slice(0, MAX_DIGEST);
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
    footer: "Sent by Cleo · manage this report from the LumiAgents dashboard &rarr; Awards.",
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
