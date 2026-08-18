import { z } from "zod";
import { defineOrchestration } from "@/runtime";
import type { Env } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { escapeHtml, fmtDeadline } from "@/runtime/utils/format";
import {
  runSubscriptionDigest,
  renderDigestShell,
  digestKv,
  type DigestSubscription,
} from "@/runtime/utils/subscription-digest";

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Cron-driven by default: the daily meta-cron fires this with no input and each
// subscription's own cadence (daily/weekly) decides whether it is due. When a
// subscriptionId is supplied (the dashboard "Send now" button), only that
// subscription is processed, the cadence check is bypassed, and the full current
// digest is sent (not just items new since the last send).
export const inputSchema = z.object({
  subscriptionId: z
    .string()
    .uuid()
    .optional()
    .describe("Manual trigger: send this one subscription now, ignoring cadence."),
});

export const outputSchema = z.object({
  subscriptionsDue: z.number(),
  emailsSent: z.number(),
  emailsSkipped: z.number(),
});

// ─── Types ──────────────────────────────────────────────────────────────────

// Opportunity digests are the kind='opportunity' rows of the unified subscriptions
// table, extended with the opportunity-specific filter columns.
interface Subscription extends DigestSubscription {
  min_fit_score: number;
  sources: string[] | null;
  agencies: string[] | null;
  set_asides: string[] | null;
}

const SUB_COLUMNS =
  "id,label,cadence,recipients,min_fit_score,last_sent_at,sources,agencies,set_asides";

interface Opportunity {
  title: string;
  agency: string | null;
  set_aside: string | null;
  response_deadline: string | null;
  source: string | null;
  source_url: string | null;
  notice_type: string | null;
  fit_score: number;
  fit_reason: string | null;
  recommendation: string | null;
  last_scored_at: string | null;
}

const MAX_DIGEST = 50;

// ─── Digest query ──────────────────────────────────────────────────────────────

// Opportunities for a subscription at or above its fit threshold, with filters applied.
//   sinceLastSent=true  (cron path)   → only items scored since the last send.
//   sinceLastSent=false (manual path) → the full current digest.
// `source` is filtered server-side; agency / set-aside are case-insensitive
// substring matches applied in JS (agency names are free text, so `in.()` is
// too strict), so we over-fetch then trim to MAX_DIGEST.
async function loadDigestOpps(
  env: Env,
  sub: Subscription,
  opts: { sinceLastSent: boolean },
): Promise<Opportunity[]> {
  const hasTextFilter =
    (sub.agencies?.length ?? 0) > 0 || (sub.set_asides?.length ?? 0) > 0;

  // The fit-score threshold is the gate: fit >= 7 is pursue-only, fit 5-6 pulls in
  // monitor-rated items too (the sweep only persists opportunities scoring >= 5,
  // so that's the floor). No hard recommendation filter; the subscriber's
  // min_fit_score decides their range.
  const params = new URLSearchParams({
    select: "title,agency,set_aside,response_deadline,source,source_url,notice_type,fit_score,fit_reason,recommendation,last_scored_at",
    fit_score: `gte.${sub.min_fit_score}`,
    // Never surface 'pass': an opportunity re-scored down to pass (an amendment
    // narrowed its fit) is out of scope regardless of the fit threshold.
    recommendation: "neq.pass",
    order: "fit_score.desc,last_scored_at.desc",
    limit: hasTextFilter ? "200" : String(MAX_DIGEST),
  });
  if (opts.sinceLastSent && sub.last_sent_at) {
    params.append("last_scored_at", `gt.${sub.last_sent_at}`);
  }
  if (sub.sources?.length) {
    params.append("source", `in.(${sub.sources.join(",")})`);
  }

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/opportunities?${params.toString()}`, {
    headers: sbHeaders(env),
  });
  if (!res.ok) throw new Error(`load opportunities → ${res.status}: ${await res.text()}`);
  let rows = (await res.json()) as Opportunity[];

  const matchesAny = (value: string | null, needles: string[]): boolean => {
    if (!value) return false;
    const hay = value.toLowerCase();
    return needles.some((n) => hay.includes(n.toLowerCase()));
  };
  if (sub.agencies?.length) rows = rows.filter((o) => matchesAny(o.agency, sub.agencies!));
  if (sub.set_asides?.length) rows = rows.filter((o) => matchesAny(o.set_aside, sub.set_asides!));

  return rows.slice(0, MAX_DIGEST);
}

// ─── HTML rendering ─────────────────────────────────────────────────────────

// Fit-badge colors by tier: pursue = green, monitor = amber, else neutral.
function tierColor(recommendation: string | null): { bg: string; fg: string } {
  if (recommendation === "pursue") return { bg: "#dcfce7", fg: "#166534" };
  if (recommendation === "monitor") return { bg: "#fef9c3", fg: "#854d0e" };
  return { bg: "#f3f4f6", fg: "#374151" };
}

// Notice-type badge. Market-research notices (Sources Sought / Presolicitation /
// RFI) are highlighted amber, because they take a capability statement rather than
// a bid, while full solicitations get a neutral indigo tag.
function noticeTag(noticeType: string | null): string {
  if (!noticeType) return "";
  const t = noticeType.toLowerCase();
  const isRfi =
    t.includes("sources sought") ||
    t.includes("presolicitation") ||
    t.includes("special notice") ||
    t.includes("information") ||
    t.includes("rfi");
  const bg = isRfi ? "#fef3c7" : "#e0e7ff";
  const fg = isRfi ? "#92400e" : "#3730a3";
  return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-right:6px;text-transform:uppercase;letter-spacing:.03em;vertical-align:middle;">${escapeHtml(noticeType)}</span>`;
}

function sourceLabel(source: string | null): string {
  if (source === "sam_gov") return "SAM.gov";
  if (source === "sbir") return "SBIR/STTR";
  return escapeHtml(source ?? "-");
}

function renderEmail(
  sub: Subscription,
  opps: Opportunity[],
  opts: { manual: boolean },
): { subject: string; html: string } {
  const adj = opts.manual ? "" : "new ";
  const heading = opts.manual ? "Matching opportunities" : "New matching opportunities";
  const subject = `Beady: ${opps.length} ${adj}${opps.length === 1 ? "opportunity" : "opportunities"} (fit ≥ ${sub.min_fit_score})`;

  // Compact summary of any active filters, shown under the heading.
  const filterBits: string[] = [`fit ≥ ${sub.min_fit_score}`];
  if (sub.sources?.length) filterBits.push(sub.sources.map(sourceLabel).join(" / "));
  if (sub.agencies?.length) filterBits.push(`agency: ${sub.agencies.join(", ")}`);
  if (sub.set_asides?.length) filterBits.push(`set-aside: ${sub.set_asides.join(", ")}`);

  // Single-column stacked cards render cleanly on phone and desktop (a wide
  // multi-column table overflowed narrow mobile clients). One card per opportunity.
  const cards = opps
    .map((o) => {
      const c = tierColor(o.recommendation);
      const titleHtml = o.source_url
        ? `<a href="${escapeHtml(o.source_url)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(o.title)}</a>`
        : escapeHtml(o.title);
      return `
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin-bottom:12px;">
        <table role="presentation" width="100%" style="border-collapse:collapse;margin-bottom:8px;"><tr>
          <td style="vertical-align:top;">${noticeTag(o.notice_type)}</td>
          <td style="vertical-align:top;text-align:right;white-space:nowrap;">
            <span style="display:inline-block;background:${c.bg};color:${c.fg};border-radius:9999px;padding:2px 10px;font-weight:700;font-size:14px;">${o.fit_score}</span>
            ${o.recommendation ? `<span style="color:#6b7280;font-size:11px;text-transform:capitalize;margin-left:6px;">${escapeHtml(o.recommendation)}</span>` : ""}
          </td>
        </tr></table>
        <div style="font-size:16px;font-weight:700;line-height:1.3;margin-bottom:6px;color:#111827;">${titleHtml}</div>
        <div style="color:#6b7280;font-size:13px;line-height:1.5;margin-bottom:12px;">${escapeHtml(o.fit_reason ?? "")}</div>
        <table role="presentation" style="border-collapse:collapse;margin-bottom:10px;">
          ${digestKv("Agency", escapeHtml(o.agency ?? "-"))}
          ${digestKv("Deadline", fmtDeadline(o.response_deadline))}
          ${digestKv("Source", sourceLabel(o.source))}
        </table>
        ${o.source_url ? `<a href="${escapeHtml(o.source_url)}" style="color:#2563eb;text-decoration:none;font-size:13px;font-weight:600;">View on ${sourceLabel(o.source)} &rarr;</a>` : ""}
      </div>`;
    })
    .join("");

  const html = renderDigestShell({
    heading,
    label: sub.label ?? "Opportunity report",
    cadence: sub.cadence,
    filterBits,
    cards,
    footer: "Sent by Beady &middot; manage this digest in LumiAgents under Settings &rarr; Subscriptions.",
  });

  return { subject, html };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export default defineOrchestration({
  name: "beady/opportunity-report",
  version: 1,
  description:
    "Email matching opportunities (at or above each subscription's fit threshold) to report subscribers. Driven by a daily meta-cron; each subscription's cadence (daily/weekly), fit threshold and filters are honored.",
  cron: "0 13 * * *",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    return runSubscriptionDigest<Subscription, Opportunity>(ctx, input, {
      kind: "opportunity",
      subColumns: SUB_COLUMNS,
      sender: "beady",
      stepPrefix: "report",
      emptyReasonManual: "no-matching-opportunities",
      emptyReasonCron: "no-new-opportunities",
      loadRecords: loadDigestOpps,
      renderEmail,
    });
  },
});
