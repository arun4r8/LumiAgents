// Platform limits we have actually hit, written down so they can be reasoned about
// before a run dies rather than after.

/**
 * Cloudflare Workers allows this many subrequests per invocation. A "subrequest" is
 * any outbound fetch: Supabase reads and writes, Anthropic calls, third-party APIs.
 * Workflow steps within one instance share the invocation, so the budget is spent
 * across the WHOLE orchestration, not per step.
 *
 * 50 is the Workers Free ceiling. Paid is 1000. This is set to the lower of the two
 * deliberately: a run that fits in 50 also fits in 1000, and the alternative is
 * discovering the difference in production, which is how we found the number.
 *
 * Exceeding it throws "Too many subrequests by single Worker invocation" and kills
 * the run wherever it happens to be, discarding everything done so far. There is no
 * partial credit: beady/opportunity-sweep scored 133 notices across six LLM calls
 * and threw all of it away on the seventh.
 */
export const WORKER_SUBREQUEST_LIMIT = 50;

/**
 * What one `llm_extract` costs in Workflow mode: the Anthropic call, plus a
 * createRunStep and an updateRunStep. All three sit inside `wf.do`, so a replay
 * pays 0 -- but a first pass pays 3, per call.
 *
 * This is why batch size is a subrequest decision and not only a token decision.
 * Halving a batch doubles the number of calls and so doubles this cost.
 */
export const SUBREQUESTS_PER_LLM_EXTRACT = 3;

/** What one `step()` costs in Workflow mode: createRunStep + updateRunStep. */
export const SUBREQUESTS_PER_STEP = 2;

/** What one `defineTool` call costs: createToolCall + updateToolCall. */
export const SUBREQUESTS_PER_TOOL_CALL = 2;
