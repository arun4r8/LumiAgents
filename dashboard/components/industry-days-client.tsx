"use client";

import { useState, useTransition } from "react";
import { CalendarClock, Sparkles, Loader2, Trash2, ExternalLink, MapPin } from "lucide-react";
import type { IndustryDay } from "@/app/(dashboard)/records/bd/industry-days";

interface Props {
  events: IndustryDay[];
  /** "Yesterday", as a single instant fixed by the server. Not derived here: see
   *  the note at the call site in app/(dashboard)/records/bd/industry-days.tsx. */
  cutoffMs: number;
  dismiss: (formData: FormData) => Promise<void>;
  findNow: () => Promise<void>;
}

const REC_COLOR: Record<string, string> = {
  attend: "oklch(58% 0.16 145)",
  consider: "oklch(62% 0.15 250)",
  skip: "oklch(60% 0.02 260)",
};

/** event_date is a DATE column, and appending T00:00:00 parses it as LOCAL
 *  midnight, then formats in that same zone. That round trip is timezone-stable
 *  (Aug 15 reads as Aug 15 in UTC, New York and Tokyo alike), so this needs no
 *  <LocalTime> gate. The locale was the only thing that varied: `undefined`
 *  takes the runtime's, which differs between the SSR render and the browser
 *  and mismatches on hydration. Pinning en-US removes the last variable and
 *  matches every other formatter in components/lumi.tsx. */
function fmtDate(iso: string | null): string {
  if (!iso) return "Date TBD";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function daysUntil(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00").getTime();
  if (isNaN(d)) return null;
  const n = Math.ceil((d - Date.now()) / 86_400_000);
  if (n < 0) return "past";
  if (n === 0) return "today";
  return `in ${n}d`;
}

export function IndustryDaysClient({ events, cutoffMs, dismiss, findNow }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [justStarted, setJustStarted] = useState(false);

  const upcoming = events.filter((e) => !e.event_date || new Date(e.event_date + "T00:00:00").getTime() >= cutoffMs);

  function handleFind() {
    setError(null);
    startTransition(async () => {
      try { await findNow(); setJustStarted(true); setTimeout(() => setJustStarted(false), 8000); }
      catch (e) { setError(e instanceof Error ? e.message : "Failed to start sweep"); }
    });
  }

  return (
    <div className="page view-fade">
      <div className="page-h">
        <div>
          <h1><CalendarClock size={20} style={{ verticalAlign: "-3px", marginRight: 8 }} />Industry Days</h1>
          <div className="sub">
            {events.length === 0 ? "No industry days on the radar yet." : `${upcoming.length} upcoming · ${events.length} total`}
          </div>
        </div>
        <button className="btn" onClick={handleFind} disabled={pending}>
          {pending ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Run a sweep
        </button>
      </div>

      <p className="sub" style={{ marginBottom: 16, maxWidth: 780 }}>
        Government agency industry days, vendor-outreach, and small-business matchmaking events, discovered from
        SAM.gov Special Notices and the web, scored for relevance to Lumiture. &ldquo;Find with Beady&rdquo; runs a
        fresh sweep in the background (~30–60s); new events appear here.
      </p>

      {justStarted && <div className="chip ok" style={{ marginBottom: 12 }}>Sweep started; refresh in a bit to see new events.</div>}
      {error && <div className="chip" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div>}

      {events.length === 0 ? (
        <div className="empty">
          <div className="ico"><CalendarClock /></div>
          <h4>Nothing yet.</h4>
          <p>Run a sweep with Beady to populate upcoming industry days.</p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {events.map((e) => {
            const until = daysUntil(e.event_date);
            return (
              <div key={e.id} className="card" style={{ padding: 16, display: "grid", gap: 8, opacity: e.recommendation === "skip" ? 0.65 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{e.title}</div>
                    <div className="sub" style={{ marginTop: 2 }}>{e.agency ?? "Agency TBD"}</div>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
                    {e.fit_score != null && (
                      <span className="chip" style={{ color: REC_COLOR[e.recommendation], borderColor: REC_COLOR[e.recommendation] }}>
                        {e.recommendation} · {e.fit_score}/10
                      </span>
                    )}
                    <span className="chip" style={{ fontSize: 11 }}>{e.source === "sam_gov" ? "SAM.gov" : "web"}</span>
                  </div>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 13, color: "var(--ink-2)" }}>
                  <span><CalendarClock size={13} style={{ verticalAlign: "-2px" }} /> {fmtDate(e.event_date)}{until && until !== "past" ? ` (${until})` : ""}</span>
                  {e.location && <span><MapPin size={13} style={{ verticalAlign: "-2px" }} /> {e.location}</span>}
                  {e.format && <span className="chip" style={{ fontSize: 11 }}>{e.format}</span>}
                </div>

                {e.description && <div className="sub">{e.description}</div>}
                {e.fit_reason && <div style={{ fontSize: 12.5, color: "var(--ink-3)", fontStyle: "italic" }}>{e.fit_reason}</div>}

                <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                  {(e.registration_url || e.source_url) && (
                    <a className="btn sm" href={e.registration_url ?? e.source_url ?? "#"} target="_blank" rel="noreferrer">
                      <ExternalLink size={13} /> {e.registration_url ? "Register" : "View"}
                    </a>
                  )}
                  <form action={dismiss} style={{ marginLeft: "auto" }}>
                    <input type="hidden" name="id" value={e.id} />
                    <button className="btn sm danger" type="submit" title="Dismiss"><Trash2 size={13} /> Dismiss</button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
