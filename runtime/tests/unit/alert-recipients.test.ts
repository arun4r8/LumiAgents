import { describe, it, expect, afterEach, vi } from "vitest";
import { subscriptionRecipients } from "../../../integrations/resend/alert";

/**
 * #233: every operational alert called subscriptionRecipients() with no kind, which
 * returned the recipients of EVERY subscription -- the business digest list, one
 * person. A failed run paged someone who could not fix it, and nobody who could.
 *
 * The fix is only as good as the URL this builds. PostgREST ignores nothing here: a
 * missing filter is simply "all rows", which reads as success.
 */
const env = { SUPABASE_URL: "https://db.example", SUPABASE_SERVICE_ROLE_KEY: "k" } as never;

function stub(rows: Array<{ recipients: string[] }>) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    urls.push(String(u));
    return new Response(JSON.stringify(rows), { status: 200 });
  }));
  return urls;
}

describe("subscriptionRecipients", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("filters to the one kind asked for", async () => {
    const urls = stub([{ recipients: ["a@x.com"] }]);
    await subscriptionRecipients(env, "alert");
    expect(urls[0]).toContain("kind=eq.alert");
    expect(urls[0]).toContain("is_active=eq.true");
  });

  it("filters to several kinds with in.(...), not by dropping the filter", async () => {
    const urls = stub([]);
    await subscriptionRecipients(env, ["opportunity", "award"]);
    expect(urls[0]).toContain("kind=in.(opportunity,award)");
  });

  it("never builds an unfiltered query -- that is the original bug", async () => {
    const urls = stub([]);
    await subscriptionRecipients(env, "opportunity");
    await subscriptionRecipients(env, ["alert"]);
    for (const u of urls) expect(u).toMatch(/[?&]kind=(eq|in)\./);
  });

  it("returns nobody for an empty kind list, instead of everybody", async () => {
    const urls = stub([{ recipients: ["everyone@x.com"] }]);
    expect(await subscriptionRecipients(env, [])).toEqual([]);
    expect(urls).toHaveLength(0);
  });

  it("dedupes and normalises addresses across rows", async () => {
    stub([{ recipients: ["A@x.com", "b@x.com"] }, { recipients: [" a@x.com "] }]);
    expect(await subscriptionRecipients(env, ["opportunity", "award"])).toEqual(["a@x.com", "b@x.com"]);
  });
});
