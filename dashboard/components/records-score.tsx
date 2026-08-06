/**
 * ScoreCell — the shared records-table score primitive.
 *
 * The redesign renders every record score in monospace, tinted `--ok` once it
 * clears 70% of its scale and neutral below that (per the handoff: "Scores mono,
 * --ok when >=70, neutral otherwise"). Most record scores are 0–100, so the
 * default `max` is 100; the BD Awards table scores fit on 0–10, so it passes
 * `max={10}` and the same 70% threshold applies (>=7).
 *
 * A null/missing score is not a zero — it renders as a dimmed em dash so an
 * unscored row reads as "not scored yet", never as a bad score.
 */
export function ScoreCell({
  score,
  max = 100,
  suffix,
}: {
  score: number | null | undefined;
  max?: number;
  /** Optional trailing unit, e.g. "/10", shown dimmed after the number. */
  suffix?: string;
}) {
  if (score == null || Number.isNaN(score)) {
    return <span className="rec-score rec-score-null">—</span>;
  }
  const ok = score / max >= 0.7;
  return (
    <span className={`rec-score${ok ? " ok" : ""}`}>
      {score}
      {suffix ? <span className="rec-score-suffix">{suffix}</span> : null}
    </span>
  );
}

export default ScoreCell;
