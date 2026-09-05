"use client";

import { useFormStatus } from "react-dom";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { LocalTime, UrgencyTag } from "@/components/lumi";
import { STAGES, type StageKey } from "@/app/(dashboard)/records/bd/board";

export interface BoardCard {
  id: string;
  title: string | null;
  agency: string | null;
  fit_score: number | null;
  recommendation: string | null;
  response_deadline: string | null;
  pipeline_stage: StageKey;
  pipeline_stage_at: string | null;
  solicitation_number: string | null;
  source_url: string | null;
}

/**
 * Move button. Reads `useFormStatus` from inside the form rather than disabling on
 * its own click -- a submit button that disables itself in its own click handler
 * never submits, which is exactly how the disposition buttons silently did nothing.
 */
function MoveButton({ direction, disabled }: { direction: "back" | "forward"; disabled: boolean }) {
  const { pending } = useFormStatus();
  const Icon = direction === "back" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-label={direction === "back" ? "Move back a stage" : "Move forward a stage"}
      className="rec-filter"
      style={{
        padding: "2px 6px",
        opacity: disabled ? 0.25 : pending ? 0.5 : 1,
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <Icon size={13} style={{ verticalAlign: "-2px" }} />
    </button>
  );
}

function Card({ card, moveCard }: { card: BoardCard; moveCard: (fd: FormData) => Promise<void> }) {
  const stageIndex = STAGES.findIndex((s) => s.key === card.pipeline_stage);
  const atStart = stageIndex <= 0;
  const atEnd = stageIndex >= STAGES.length - 1;

  return (
    <div className="card" style={{ padding: 12, display: "grid", gap: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13, lineHeight: 1.35 }}>{card.title ?? "Untitled"}</div>
      <div className="sub" style={{ fontSize: 11.5 }}>{card.agency ?? "Agency unknown"}</div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11.5, alignItems: "center" }}>
        {card.fit_score != null && <span className="tag tag-neutral">Fit {card.fit_score}/10</span>}
        {card.response_deadline ? (
          <UrgencyTag expiresAt={card.response_deadline} />
        ) : (
          <span style={{ color: "var(--ink-3)" }}>No deadline</span>
        )}
      </div>

      {/* The design's card carries a contract value. We do not hold one: there is no
          value column on opportunities, and the syncup listed estimated value via
          spreadsheet match as a future addition. Saying so is better than rendering an
          empty field that reads as a bug. */}
      <div className="sub" style={{ fontSize: 11, color: "var(--ink-3)" }}>Contract value not captured yet</div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <div style={{ display: "flex", gap: 4 }}>
          <form action={moveCard}>
            <input type="hidden" name="id" value={card.id} />
            <input type="hidden" name="direction" value="back" />
            <MoveButton direction="back" disabled={atStart} />
          </form>
          <form action={moveCard}>
            <input type="hidden" name="id" value={card.id} />
            <input type="hidden" name="direction" value="forward" />
            <MoveButton direction="forward" disabled={atEnd} />
          </form>
        </div>
        {card.source_url && (
          <a href={card.source_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>
            SAM.gov <ExternalLink size={11} style={{ verticalAlign: "-1px" }} />
          </a>
        )}
      </div>

      {card.pipeline_stage_at && (
        <div className="sub" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
          Moved <LocalTime iso={card.pipeline_stage_at} format="date" placeholder="-" />
        </div>
      )}
    </div>
  );
}

export function PipelineBoardClient({
  cards,
  moveCard,
}: {
  cards: BoardCard[];
  moveCard: (formData: FormData) => Promise<void>;
}) {
  return (
    <div className="page view-fade" style={{ paddingTop: 0 }}>
      <div className="page-h">
        <div>
          <h1>Pipeline</h1>
          <div className="sub">
            {cards.length === 0
              ? "Nothing in the pipeline yet."
              : `${cards.length} opportunit${cards.length === 1 ? "y" : "ies"} being pursued`}
          </div>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="empty">
          <h4>Nothing being pursued.</h4>
          <p>
            Mark an opportunity <strong>Pursue</strong> on the Opportunities tab and it appears
            here, in the first column.
          </p>
        </div>
      ) : (
        // Horizontal scroll on the container, never the page body: five columns do not
        // fit a laptop, and a page that scrolls sideways loses the nav.
        <div style={{ overflowX: "auto", paddingBottom: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(230px, 1fr))`, gap: 12, minWidth: 1180 }}>
            {STAGES.map((stage) => {
              const inStage = cards.filter((c) => c.pipeline_stage === stage.key);
              return (
                <div key={stage.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12.5, textTransform: "uppercase", letterSpacing: 0.4 }}>
                      {stage.label} <span style={{ opacity: 0.5 }}>{inStage.length}</span>
                    </div>
                    {/* The action the stage is waiting on, from the design's
                        "action required" field -- a column heading alone does not say
                        what a human is meant to do next. */}
                    <div className="sub" style={{ fontSize: 11 }}>{stage.action}</div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {inStage.map((c) => <Card key={c.id} card={c} moveCard={moveCard} />)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
