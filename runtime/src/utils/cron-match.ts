/**
 * Lightweight 5-field cron matcher for Cloudflare Workers (no Node deps).
 * Supports: * | n | n-m | *\/n | n-m/n | n,m,o  (UTC times)
 */

function matchField(expr: string, value: number): boolean {
  if (expr === "*") return true;

  if (expr.includes("/")) {
    const [range, stepStr] = expr.split("/");
    const step = parseInt(stepStr ?? "1", 10);
    if (range === "*") return value % step === 0;
    const [lo, hi] = (range ?? "").split("-").map(Number);
    const low = lo ?? 0;
    const high = hi ?? low;
    return value >= low && value <= high && (value - low) % step === 0;
  }

  if (expr.includes(",")) {
    return expr.split(",").map(Number).includes(value);
  }

  if (expr.includes("-")) {
    const [lo, hi] = expr.split("-").map(Number);
    return value >= (lo ?? 0) && value <= (hi ?? 0);
  }

  return parseInt(expr, 10) === value;
}

/** Returns true if the cron expression matches the given Date (UTC fields). */
export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hrF, domF, monF, dowF] = parts;
  return (
    matchField(minF ?? "*", date.getUTCMinutes()) &&
    matchField(hrF  ?? "*", date.getUTCHours()) &&
    matchField(domF ?? "*", date.getUTCDate()) &&
    matchField(monF ?? "*", date.getUTCMonth() + 1) &&
    matchField(dowF ?? "*", date.getUTCDay())
  );
}

/**
 * Returns true if a schedule is due to run.
 * Checks the last `windowMinutes` minutes to absorb Cloudflare cron jitter
 * (~1 min typical). Guards against double-runs using lastRunAt.
 */
export function scheduleDue(
  cronExpr: string,
  now: Date,
  lastRunAt: Date | null,
  windowMinutes = 5,
): boolean {
  for (let i = 0; i <= windowMinutes; i++) {
    const t = new Date(now.getTime() - i * 60_000);
    t.setUTCSeconds(0, 0);
    if (!cronMatches(cronExpr, t)) continue;
    // Matched — only run if we haven't already fired for this occurrence.
    if (lastRunAt === null || lastRunAt < t) return true;
    return false;
  }
  return false;
}
