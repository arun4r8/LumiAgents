import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getGraphToken, resetGraphTokenCache } from "../../../integrations/msgraph/base";
import {
  WORKER_SUBREQUEST_LIMIT,
} from "../../src/config/limits";
import {
  MAX_RESUMES_PER_RUN,
  SUBREQUESTS_PER_RESUME,
} from "../../../orchestrations/angie/resume-scoring/definition";

/**
 * Every Graph call used to fetch a fresh token first, making each one TWO
 * subrequests: login.microsoftonline.com, then graph.microsoft.com.
 *
 * Cloudflare Workers Free allows 50 subrequests per invocation and a Workflow
 * spends that across the whole orchestration. cleo/content-sync writes one cell per
 * calendar row, so at ~3 subrequests a row it broke at roughly 17 rows — of a sheet
 * meant to hold a year of multi-channel posts (#221).
 */

const env = { MSGRAPH_TENANT_ID: "t", MSGRAPH_CLIENT_ID: "c", MSGRAPH_CLIENT_SECRET: "s" };

describe("getGraphToken caching", () => {
  beforeEach(() => resetGraphTokenCache());
  afterEach(() => vi.unstubAllGlobals());

  function stubToken(token: string, expiresIn = 3599) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: token, expires_in: expiresIn }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("fetches once and reuses, so a loop of Graph calls costs one token request", async () => {
    const fetchMock = stubToken("tok-1");
    for (let i = 0; i < 25; i++) await getGraphToken(env);
    // 25 Graph calls used to mean 25 token fetches, i.e. 25 wasted subrequests of 50.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the token is near expiry", async () => {
    const fetchMock = stubToken("short", 30); // shorter than the 60s refresh skew
    await getGraphToken(env);
    await getGraphToken(env);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve a token minted for a different client id", async () => {
    const fetchMock = stubToken("tok-a");
    await getGraphToken(env);
    await getGraphToken({ ...env, MSGRAPH_CLIENT_ID: "other" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still refuses to run unconfigured", async () => {
    await expect(getGraphToken({})).rejects.toThrow(/not configured/i);
  });
});

describe("resume-scoring is bounded by the subrequest ceiling", () => {
  it("caps the batch at what one invocation can actually finish", () => {
    const worstCase = MAX_RESUMES_PER_RUN * SUBREQUESTS_PER_RESUME;
    // Leave room for workflow entry, the job row and the summary step.
    expect(worstCase).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });

  it("keeps headroom rather than sitting exactly on the ceiling", () => {
    expect(WORKER_SUBREQUEST_LIMIT - MAX_RESUMES_PER_RUN * SUBREQUESTS_PER_RESUME).toBeGreaterThanOrEqual(8);
  });
});
