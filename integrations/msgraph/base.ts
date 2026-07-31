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
 * Acquire an app-only bearer token from Azure AD via the client-credentials
 * flow. Throws a clear error if any of the three MSGRAPH_* creds is missing.
 */
export async function getGraphToken(env: MsGraphEnv): Promise<string> {
  const { MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, MSGRAPH_CLIENT_SECRET } = env;
  if (!MSGRAPH_TENANT_ID || !MSGRAPH_CLIENT_ID || !MSGRAPH_CLIENT_SECRET) {
    throw new Error(
      "Microsoft Graph not configured. Set secrets MSGRAPH_TENANT_ID, " +
        "MSGRAPH_CLIENT_ID, and MSGRAPH_CLIENT_SECRET.",
    );
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

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Microsoft Graph token response had no access_token.");
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
