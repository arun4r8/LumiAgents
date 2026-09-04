import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Server-side calls from the dashboard Worker into the runtime Worker.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A Worker cannot reach another Worker on the same zone over plain HTTP.
 * Cloudflare refuses the subrequest with **error 1042**, which surfaces to a Next
 * server action as a bare `404` body reading `error code: 1042` — and, because
 * production builds redact server errors, reaches the user as the generic
 * "An error occurred in the Server Components render" banner.
 *
 * Every server-side `fetch(`${NEXT_PUBLIC_RUNTIME_URL}/api/...`)` in this app was
 * failing that way: Run-a-sweep on Industry Days, RFI drafting, content
 * draft/plan/sync, résumé redaction, Tier 2 proposals, schedules, and the
 * Knowledge page's document list. The database shows it: every user-triggered run
 * in production dates from a single 2026-08-11 session, which was local dev —
 * plain Node fetch, where 1042 does not apply.
 *
 * The runtime already solved this for its own agent dispatch with a Service
 * Binding (`runtime/src/agents/agent-chat.ts`: "Use Service Binding when available
 * (avoids CF loop-block on HTTP fetch back to runtime)"). This is the same fix on
 * the dashboard side.
 *
 * ── Why it still falls back to fetch ─────────────────────────────────────────
 * Local `next dev` has no Cloudflare context and no binding, and there 1042 does
 * not apply because the caller is Node rather than a Worker. So the binding is
 * used when present and a direct fetch otherwise — which is also what keeps this
 * safe to land before the binding exists in every environment.
 *
 * CLIENT components must NOT use this. A browser fetch to the runtime is an
 * ordinary cross-origin request and works fine; `getCloudflareContext()` would
 * throw there anyway.
 */

const RUNTIME_URL = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

interface RuntimeBinding {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

function runtimeBinding(): RuntimeBinding | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const b = env["RUNTIME_WORKER"];
    // Duck-typed rather than instanceof: the binding is a Fetcher, and the shape is
    // the only thing this needs. A missing binding must degrade, never throw.
    if (b && typeof (b as RuntimeBinding).fetch === "function") return b as RuntimeBinding;
  } catch {
    // No Cloudflare context (local dev, build-time prerender) — fall through.
  }
  return null;
}

/**
 * Fetch a runtime API path from the server.
 *
 * @param path Absolute path beginning with "/", e.g. "/api/orchestrations".
 */
export async function fetchRuntime(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith("/")) throw new Error(`fetchRuntime expects a path starting with "/", got: ${path}`);
  const binding = runtimeBinding();
  if (binding) {
    // The hostname is ignored when dispatching over a Service Binding, but a valid
    // absolute URL is still required to construct the Request.
    return binding.fetch(`https://runtime.internal${path}`, init);
  }
  return fetch(`${RUNTIME_URL}${path}`, init);
}

/** The base URL, for the few places that need to build a URL rather than call one. */
export const RUNTIME_BASE = RUNTIME_URL;
