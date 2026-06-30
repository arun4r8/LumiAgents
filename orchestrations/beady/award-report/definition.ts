import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import type { Env } from "@/runtime";
import { sendEmail } from "./tools";

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

interface AwardSubscription {
  id:           string;
  label:        string | null;
  cadence:      "daily" | "weekly";
  recipients:   string[];
  award_types:  string[] | null;
  min_fit_score: number;
  last_sent_at: string | null;
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

// ─── Supabase helpers ──────────────────────────────────────────────────────────

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey:          env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization:   `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function loadActiveSubscriptions(env: Env): Promise<AwardSubscription[]> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/award_subscriptions?is_active=eq.true&select=${SUB_COLS}`,
    { headers: sbHeaders(env, { "Accept-Profile": "orchestration" }) },
  );
  if (!res.ok) throw new Error(`load award_subscriptions → ${res.status}: ${await res.text()}`);
  return (await res.json()) as AwardSubscription[];
}

async function loadSubscriptionById(env: Env, id: string): Promise<AwardSubscription | null> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/award_subscriptions?id=eq.${id}&select=${SUB_COLS}`,
    { headers: sbHeaders(env, { "Accept-Profile": "orchestration" }) },
  );
  if (!res.ok) throw new Error(`load award subscription ${id} → ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as AwardSubscription[];
  return rows[0] ?? null;
}

async function markSent(env: Env, id: string, sentAt: string): Promise<void> {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/award_subscriptions?id=eq.${id}`,
    {
      method: "PATCH",
      headers: sbHeaders(env, { "Content-Profile": "orchestration", Prefer: "return=minimal" }),
      body: JSON.stringify({ last_sent_at: sentAt, updated_at: sentAt }),
    },
  );
  if (!res.ok) throw new Error(`mark award subscription sent ${id} → ${res.status}: ${await res.text()}`);
}

const MAX_DIGEST = 30;

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

function isDue(sub: AwardSubscription, now: number): boolean {
  if (sub.cadence === "daily") return true;
  if (!sub.last_sent_at) return true;
  const elapsed = (now - new Date(sub.last_sent_at).getTime()) / 86_400_000;
  return elapsed >= 6.5;
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(val: string | null): string {
  if (!val) return "TBD";
  const d = new Date(val);
  if (isNaN(d.getTime())) return esc(val);
  return d.toISOString().slice(0, 10);
}

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
  const subject   = `Beady Awards: ${awards.length} ${adj}${awards.length === 1 ? "opportunity" : "opportunities"} (fit ≥ ${sub.min_fit_score})`;

  const filterBits = [`fit ≥ ${sub.min_fit_score}`];
  if (sub.award_types?.length) filterBits.push(sub.award_types.join(" / "));

  const kv = (label: string, value: string) =>
    `<tr><td style="color:#6b7280;font-size:12px;padding:2px 14px 2px 0;white-space:nowrap;vertical-align:top;">${label}</td><td style="color:#374151;font-size:13px;padding:2px 0;vertical-align:top;">${value}</td></tr>`;

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
          ${kv("Sponsor", esc(a.sponsor ?? "—"))}
          ${kv("Deadline", fmtDate(deadline))}
        </table>
        ${a.source_url ? `<a href="${esc(a.source_url)}" style="color:#2563eb;text-decoration:none;font-size:13px;font-weight:600;">View award &rarr;</a>` : ""}
      </div>`;
    })
    .join("");

  const html = `<!doctype html>
<html>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <h1 style="font-size:20px;color:#111827;margin:0 0 4px;">${heading}</h1>
    <p style="color:#6b7280;margin:0 0 16px;font-size:14px;">
      ${esc(sub.label ?? "Award report")} · ${sub.cadence} · ${esc(filterBits.join(" · "))}
    </p>
    ${cards}
    <p style="color:#9ca3af;font-size:12px;margin-top:16px;">
      Sent by Beady · manage this report from the LumiAgents dashboard &rarr; Awards.
    </p>
  </div>
</body>
</html>`;

  return { subject, html };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/award-report",
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
    const manual = Boolean(input.subscriptionId);

    const subscriptions = await step(ctx, "load-subscriptions", async () => {
      if (manual) {
        const sub = await loadSubscriptionById(ctx.env, input.subscriptionId!);
        if (!sub) return [];
        return Array.isArray(sub.recipients) && sub.recipients.length > 0 ? [sub] : [];
      }
      const all = await loadActiveSubscriptions(ctx.env);
      const now = Date.now();
      return all.filter((s) => Array.isArray(s.recipients) && s.recipients.length > 0 && isDue(s, now));
    });

    let emailsSent    = 0;
    let emailsSkipped = 0;

    for (const sub of subscriptions) {
      const outcome = await step(ctx, `award-report-${sub.id}`, async () => {
        const sentAt = new Date().toISOString();
        const awards = await loadDigestAwards(ctx.env, sub, { sinceLastSent: !manual });

        if (awards.length === 0) {
          if (!manual) await markSent(ctx.env, sub.id, sentAt);
          return { sent: false as const, reason: manual ? "no-matching-awards" : "no-new-awards" };
        }

        const { subject, html } = renderEmail(sub, awards, { manual });
        const result = await sendEmail(ctx.env, { to: sub.recipients, subject, html });

        if (result.sent) {
          await markSent(ctx.env, sub.id, sentAt);
          return { sent: true as const, count: awards.length };
        }
        return { sent: false as const, reason: result.error ?? "send-failed" };
      });

      if (outcome.sent) emailsSent++;
      else emailsSkipped++;
    }

    return { subscriptionsDue: subscriptions.length, emailsSent, emailsSkipped };
  },
});
