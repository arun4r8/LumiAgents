// TODO: Wire in your accounting system before using any function in this module.
//
// Supported systems (pick one):
//   - QuickBooks Online → use the QuickBooks Accounting API (OAuth2)
//   - Unanet           → use the Unanet REST API (API key)
//   - Deltek Vision    → use the Vision REST API (API key + base URL)
//
// Required Wrangler secrets (wrangler secret put <NAME>):
//   ACCOUNTING_API_URL:    base URL of the accounting system REST API
//                          e.g. https://sandbox-quickbooks.api.intuit.com
//   ACCOUNTING_API_KEY:    API key or bearer token for the accounting system
//
// Once the secrets are set, implement the actual HTTP calls in the sibling files
// (invoices.ts, budget-lines.ts, labor-records.ts) and remove the "not configured" stubs.

/** Subset of the Worker env that the accounting integration requires. */
export interface AccountingEnv {
  ACCOUNTING_API_URL?: string;
  ACCOUNTING_API_KEY?: string;
}

/**
 * Assert that accounting env vars are present before any API call.
 * Call this at the top of every exported function in this integration.
 *
 * @throws {Error} with a clear message if either var is missing.
 */
export function assertAccountingConfigured(
  env: AccountingEnv,
): asserts env is Required<AccountingEnv> {
  if (!env.ACCOUNTING_API_URL || !env.ACCOUNTING_API_KEY) {
    throw new Error(
      "Accounting integration is not configured. " +
        "Set ACCOUNTING_API_URL and ACCOUNTING_API_KEY as Wrangler secrets, then implement " +
        "the HTTP calls in integrations/accounting/invoices.ts, budget-lines.ts, and labor-records.ts.",
    );
  }
}
