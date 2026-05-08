// TODO: Wire in your HR system before using any function in this module.
//
// Supported systems (pick one):
//   - BambooHR  → use the BambooHR API v1 (API key in Basic auth header)
//   - Workday   → use the Workday REST API (OAuth2 client-credentials)
//   - ADP       → use the ADP Workforce Now API (OAuth2)
//
// Required Wrangler secrets (wrangler secret put <NAME>):
//   HR_API_URL   — base URL of the HR system REST API, e.g. https://api.bamboohr.com/api/gateway.php/yourcompany/v1
//   HR_API_KEY   — API key or bearer token for the HR system
//
// Once the secrets are set, implement the actual HTTP calls in employees.ts (and any
// future files in this directory) and remove the "not configured" stubs.

/** Subset of the Worker env that the HR integration requires. */
export interface HrEnv {
  HR_API_URL?: string;
  HR_API_KEY?: string;
}

/**
 * Assert that HR env vars are present before any API call.
 * Call this at the top of every exported function in this integration.
 *
 * @throws {Error} with a clear message if either var is missing.
 */
export function assertHrConfigured(env: HrEnv): asserts env is Required<HrEnv> {
  if (!env.HR_API_URL || !env.HR_API_KEY) {
    throw new Error(
      "HR integration is not configured. " +
        "Set HR_API_URL and HR_API_KEY as Wrangler secrets, then implement " +
        "the HTTP calls in integrations/hr/employees.ts.",
    );
  }
}
