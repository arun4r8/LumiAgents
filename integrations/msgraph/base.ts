/**
 * Microsoft Graph integration: shared auth + GET helper.
 *
 * App-only (client-credentials) access to Microsoft 365. Used to live-sync the
 * content-calendar planning workbook from SharePoint/OneDrive via the Graph
 * workbook (Excel) API, replacing the manual CSV export/import.
 *
 * Requires an Azure AD app registration with application permissions
 * (e.g. Files.Read.All / Sites.Read.All, admin-consented). Set as secrets:
 *   MSGRAPH_TENANT_ID       (directory/tenant GUID)
 *   MSGRAPH_CLIENT_ID       (app registration application/client ID)
 *   MSGRAPH_CLIENT_SECRET   (app registration client secret)
 */

import { callJson } from "../http";

export interface MsGraphEnv {
  MSGRAPH_TENANT_ID?: string;
  MSGRAPH_CLIENT_ID?: string;
  MSGRAPH_CLIENT_SECRET?: string;
}

/**
 * Cached token, keyed by client id so a config change cannot serve a stale one.
 *
 * Module scope, so it lives as long as the isolate: within a single Worker
 * invocation it is always a hit after the first call, which is the case that
 * matters. Across invocations it is a bonus, not something to rely on.
 *
 * WHY THIS EXISTS. Every graphGet/graphPatch/graphPost fetched a fresh token
 * first, so each one was TWO subrequests -- login.microsoftonline.com, then
 * graph.microsoft.com. Cloudflare Workers Free allows 50 per invocation, and
 * cleo/content-sync writes one cell per calendar row: ~3 subrequests a row, so it
 * broke at roughly 17 rows of a sheet that is meant to hold a year of posts (#221).
 * Caching the token halves every Graph loop in the codebase.
 */
let tokenCache: { clientId: string; token: string; expiresAt: number } | null = null;

/** Refresh this long before the token actually expires. */
const TOKEN_SKEW_MS = 60_000;

/** Test seam: drop the cached token. */
export function resetGraphTokenCache(): void {
  tokenCache = null;
}

/**
 * Acquire an app-only bearer token from Azure AD via the client-credentials
 * flow. Throws a clear error if any of the three MSGRAPH_* creds is missing.
 *
 * Cached until shortly before expiry -- see tokenCache above for why that matters
 * more than it looks.
 */
export async function getGraphToken(env: MsGraphEnv): Promise<string> {
  const { MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, MSGRAPH_CLIENT_SECRET } = env;
  if (!MSGRAPH_TENANT_ID || !MSGRAPH_CLIENT_ID || !MSGRAPH_CLIENT_SECRET) {
    throw new Error(
      "Microsoft Graph not configured. Set secrets MSGRAPH_TENANT_ID, " +
        "MSGRAPH_CLIENT_ID, and MSGRAPH_CLIENT_SECRET.",
    );
  }

  const now = Date.now();
  if (tokenCache && tokenCache.clientId === MSGRAPH_CLIENT_ID && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const resp = await fetch(
    `https://login.microsoftonline.com/${MSGRAPH_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MSGRAPH_CLIENT_ID,
        client_secret: MSGRAPH_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    },
  );

  if (!resp.ok) {
    throw new Error(`Microsoft Graph token → ${resp.status}: ${await resp.text()}`);
  }

  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Microsoft Graph token response had no access_token.");

  // Azure returns expires_in seconds (typically 3599). Fall back to a short life if
  // it is absent: a token we re-fetch too often is a performance bug, one we hold
  // past expiry is an outage.
  const lifetimeMs = (data.expires_in ?? 300) * 1000;
  tokenCache = {
    clientId: MSGRAPH_CLIENT_ID,
    token: data.access_token,
    expiresAt: now + Math.max(0, lifetimeMs - TOKEN_SKEW_MS),
  };
  return data.access_token;
}

/**
 * GET `https://graph.microsoft.com/v1.0${path}` with an app-only bearer token,
 * returning the parsed JSON body typed as `T`.
 */
export async function graphGet<T>(env: MsGraphEnv, path: string): Promise<T> {
  const token = await getGraphToken(env);
  return callJson<T>(
    fetch,
    `https://graph.microsoft.com/v1.0${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    { label: `Microsoft Graph GET ${path}` },
  );
}

/**
 * PATCH `https://graph.microsoft.com/v1.0${path}` with an app-only bearer token and
 * a JSON body, returning the parsed JSON response typed as `T`. Used by the two-way
 * content sync to write individual worksheet cells back to the planning workbook.
 */
export async function graphPatch<T>(env: MsGraphEnv, path: string, body: unknown): Promise<T> {
  const token = await getGraphToken(env);
  return callJson<T>(
    fetch,
    `https://graph.microsoft.com/v1.0${path}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { label: `Microsoft Graph PATCH ${path}` },
  );
}

/**
 * POST `https://graph.microsoft.com/v1.0${path}` with an app-only bearer token and a
 * JSON body, returning the parsed JSON response typed as `T`. Used to append new rows
 * to the content-calendar Excel table.
 */
export async function graphPost<T>(env: MsGraphEnv, path: string, body: unknown): Promise<T> {
  const token = await getGraphToken(env);
  return callJson<T>(
    fetch,
    `https://graph.microsoft.com/v1.0${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { label: `Microsoft Graph POST ${path}` },
  );
}


/**
 * Microsoft Graph's JSON batch endpoint: up to 20 requests in one HTTP call.
 *
 * https://learn.microsoft.com/graph/json-batching
 *
 * Written for the same reason as the token cache: a Cloudflare Worker gets 50
 * subrequests per invocation, and a loop issuing one Graph call per spreadsheet
 * cell spends that budget on framing rather than work. Twenty cells per request
 * turns a 60-cell sync from 60 subrequests into 3.
 *
 * Graph returns HTTP 200 for the batch itself even when individual requests inside
 * it failed, so per-request statuses MUST be inspected -- a caller that checks only
 * the outer response will report success for a batch that wrote nothing. That is
 * the whole trap of this endpoint and why this helper raises rather than returning
 * the raw envelope.
 */
export const GRAPH_BATCH_MAX = 20;

export interface GraphBatchRequest {
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: unknown;
}

interface GraphBatchResponse {
  responses: { id: string; status: number; body?: unknown }[];
}

export async function graphBatch(env: MsGraphEnv, requests: GraphBatchRequest[]): Promise<void> {
  for (let i = 0; i < requests.length; i += GRAPH_BATCH_MAX) {
    const chunk = requests.slice(i, i + GRAPH_BATCH_MAX);
    const token = await getGraphToken(env);
    const res = await callJson<GraphBatchResponse>(
      fetch,
      "https://graph.microsoft.com/v1.0/$batch",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: chunk.map((r) => ({
            id: r.id,
            method: r.method,
            url: r.url,
            ...(r.body === undefined ? {} : { body: r.body, headers: { "Content-Type": "application/json" } }),
          })),
        }),
      },
      { label: "Microsoft Graph $batch" },
    );

    // The outer 200 says nothing about the inner requests.
    const failed = (res.responses ?? []).filter((r) => r.status >= 300);
    if (failed.length > 0) {
      const detail = failed
        .slice(0, 3)
        .map((f) => `${f.id} → ${f.status}: ${JSON.stringify(f.body).slice(0, 200)}`)
        .join("; ");
      throw new Error(
        `Microsoft Graph $batch: ${failed.length} of ${chunk.length} request(s) failed. ${detail}`,
      );
    }
  }
}
