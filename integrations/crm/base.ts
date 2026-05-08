// TODO: Wire in your CRM before using any function in this module.
//
// Supported systems (pick one):
//   - Salesforce   → use the Salesforce REST API (OAuth2 client-credentials)
//   - HubSpot      → use the HubSpot Private App token
//   - Deltek Costpoint → use the Costpoint web services API
//
// Required Wrangler secrets (wrangler secret put <NAME>):
//   CRM_API_URL   — base URL of the CRM REST API, e.g. https://yourinstance.salesforce.com
//   CRM_API_KEY   — API key or bearer token for the CRM
//
// Once the secrets are set, implement the actual HTTP calls in contracts.ts (and any
// future files in this directory) and remove the "not configured" stubs.

/** Subset of the Worker env that the CRM integration requires. */
export interface CrmEnv {
  CRM_API_URL?: string;
  CRM_API_KEY?: string;
}

/**
 * Assert that CRM env vars are present before any API call.
 * Call this at the top of every exported function in this integration.
 *
 * @throws {Error} with a clear message if either var is missing.
 */
export function assertCrmConfigured(env: CrmEnv): asserts env is Required<CrmEnv> {
  if (!env.CRM_API_URL || !env.CRM_API_KEY) {
    throw new Error(
      "CRM integration is not configured. " +
        "Set CRM_API_URL and CRM_API_KEY as Wrangler secrets, then implement " +
        "the HTTP calls in integrations/crm/contracts.ts.",
    );
  }
}
