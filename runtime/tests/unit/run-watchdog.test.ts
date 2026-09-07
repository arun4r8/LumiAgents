import { describe, it, expect } from "vitest";
import {
  cronIntervalMinutes,
  findStuckRuns,
  findOverdueSchedules,
  findEmptyRuns,
} from "../../../orchestrations/system/run-watchdog/definition";

/**
 * Every case below is one that actually happened on 2026-09-07 and alerted nobody.
 * The fixtures are the real runs, not invented ones.
 */

const NOW = new Date("2026-09-07T21:00:00Z");
const run = (o: Partial<Parameters<typeof findStuckRuns>[0][number]>) =>
  ({
    id: "r",
    status: "completed",
    started_at: NOW.toISOString(),
    output: null,
    orchestrations: { name: "beady/opportunity-sweep" },
    ...o,
  }) as Parameters<typeof findStuckRuns>[0][number];

describe("findStuckRuns", () => {
  it("catches the run Cloudflare killed, which the database still calls 'running'", () => {
    // The real one: started 18:39, killed by the subrequest ceiling at 18:46, and
    // still 'running' hours later because the invocation that would have written
    // the failure is the invocation that died.
    const found = findStuckRuns(
      [run({ id: "db07849c", status: "running", started_at: "2026-09-07T18:39:01Z" })],
      NOW,
      90,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("stuck");
    // The message has to name the one command that reveals the truth.
    expect(found[0]!.detail).toContain("wrangler workflows instances describe");
  });

  it("leaves a legitimately long run alone", () => {
    // A real sweep takes ~10-30 minutes. Alerting on those trains people to ignore it.
    const found = findStuckRuns(
      [run({ status: "running", started_at: "2026-09-07T20:35:00Z" })],
      NOW,
      90,
    );
    expect(found).toEqual([]);
  });

  it("ignores runs that already reached a terminal state", () => {
    expect(findStuckRuns([run({ status: "failed", started_at: "2026-09-06T00:00:00Z" })], NOW, 90)).toEqual([]);
  });
});

describe("findOverdueSchedules", () => {
  const sched = (o: Partial<Parameters<typeof findOverdueSchedules>[0][number]>) =>
    ({
      orchestration_name: "beady/opportunity-sweep",
      cron_expression: "0 8 * * *",
      is_active: true,
      last_run_at: NOW.toISOString(),
      created_at: "2026-01-01T00:00:00Z",
      ...o,
    }) as Parameters<typeof findOverdueSchedules>[0][number];

  it("catches a daily schedule that has not fired in days", () => {
    const found = findOverdueSchedules([sched({ last_run_at: "2026-09-04T08:00:00Z" })], NOW, 2.5);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("overdue");
  });

  it("does not cry wolf on a schedule that ran this morning", () => {
    expect(findOverdueSchedules([sched({ last_run_at: "2026-09-07T08:00:00Z" })], NOW, 2.5)).toEqual([]);
  });

  it("flags a schedule that has never run and has been around long enough to have", () => {
    expect(findOverdueSchedules([sched({ last_run_at: null, created_at: "2026-01-01T00:00:00Z" })], NOW, 2.5)).toHaveLength(1);
  });

  it("gives a NEWLY REGISTERED schedule until its first firing before complaining", () => {
    // The watchdog's own first production run alerted about beady/opportunity-hydrate
    // -- registered thirty minutes earlier, next due at 08:20, entirely healthy. An
    // alert that fires on a correctly-configured new schedule is precisely the noise
    // this orchestration exists to avoid producing, and it went to a real person.
    const justCreated = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    expect(findOverdueSchedules([sched({ last_run_at: null, created_at: justCreated })], NOW, 2.5)).toEqual([]);
  });

  it("says which case it is, so the reader is not left guessing", () => {
    const [found] = findOverdueSchedules([sched({ last_run_at: null, created_at: "2026-01-01T00:00:00Z" })], NOW, 2.5);
    expect(found!.detail).toMatch(/has never run/);
    const [ran] = findOverdueSchedules([sched({ last_run_at: "2026-09-04T08:00:00Z" })], NOW, 2.5);
    expect(ran!.detail).toMatch(/last ran/);
  });

  it("says nothing about a deliberately disabled schedule", () => {
    // cleo/content-sync is is_active=false on purpose; nagging about it is noise.
    expect(findOverdueSchedules([sched({ is_active: false, last_run_at: null })], NOW, 2.5)).toEqual([]);
  });
});

describe("findEmptyRuns", () => {
  it("catches the completed-but-empty run that tripped nothing else", () => {
    // The 02:57 run: completed, samFound 0, because the SAM fetch had 504'd.
    const found = findEmptyRuns(
      [
        run({ output: { samFound: 0 } }),
        run({ output: { samFound: 161 } }),
        run({ output: { samFound: 161 } }),
      ],
      3,
    );
    expect(found.some((f) => f.kind === "empty" && f.detail.includes("samFound=0"))).toBe(true);
  });

  it("does not fire on a large but legitimate drop", () => {
    // samFound went from 8,343 to 161 the day the NAICS filter started reaching SAM.
    // That is a 50x drop and the most important CORRECT change of the week. A
    // proportional rule alerts on it; this one must not, because a watchdog that
    // cries wolf on correct behaviour is worth less than no watchdog.
    const found = findEmptyRuns(
      [run({ output: { samFound: 161 } }), run({ output: { samFound: 8343 } })],
      3,
    );
    expect(found).toEqual([]);
  });

  it("catches a shortlist of zero drawn from a healthy match set", () => {
    // Scoring broken while fetching works: samFound fine, nothing kept.
    const found = findEmptyRuns(
      [
        run({ output: { samFound: 161, shortlistCount: 0 } }),
        run({ output: { samFound: 161, shortlistCount: 24 } }),
      ],
      3,
    );
    expect(found.some((f) => f.detail.includes("shortlistCount=0"))).toBe(true);
  });

  it("stays quiet when there is no history to compare against", () => {
    expect(findEmptyRuns([run({ output: { samFound: 0 } })], 3)).toEqual([]);
  });
});

describe("cronIntervalMinutes", () => {
  it("reads the schedules this platform actually uses", () => {
    expect(cronIntervalMinutes("0 8 * * *")).toBe(60 * 24); // daily sweep
    expect(cronIntervalMinutes("20 * * * *")).toBe(60); // this watchdog
    expect(cronIntervalMinutes("0 9 * * 1")).toBe(60 * 24 * 7); // weekly award sweep
  });

  it("returns null rather than guessing at something malformed", () => {
    expect(cronIntervalMinutes("nonsense")).toBeNull();
    expect(cronIntervalMinutes("")).toBeNull();
  });
});
