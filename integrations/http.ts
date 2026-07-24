// Shared HTTP helper for integration wrappers.
//
// Each integration base wrapper re-implemented the same shape:
//   const res = await fetch(url, init);
//   if (!res.ok) throw new Error(`<Label> → ${res.status}: ${await res.text()}`);
//   return res.json();
// `callJson` extracts exactly that — fetch, throw on !ok with the caller's label,
// otherwise parse JSON. It is a pure extraction: no retry (the orchestration
// `step()` primitive already provides that), no extra error handling.

/**
 * Fetch `url`, throw `` `${opts.label} → ${status}: ${body}` `` on a non-2xx
 * response, otherwise parse and return the JSON body typed as `T`.
 *
 * `fetchImpl` is passed in (e.g. `ctx.fetch`) so callers keep their own
 * fetch binding; `init` is forwarded verbatim to it.
 */
export async function callJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  opts: { label: string },
): Promise<T> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    throw new Error(`${opts.label} → ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}
