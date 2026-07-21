// TODO: Implement CRM contract sync.
//
// This stub satisfies the type contract that orchestrations depend on.
// To implement:
//   1. Choose the target CRM (Salesforce, HubSpot, Deltek Costpoint, …)
//   2. Set CRM_API_URL and CRM_API_KEY via `wrangler secret put`
//   3. Replace the throw below with real HTTP calls and map the CRM response
//      fields onto ContractRecord
//   4. Add an idempotency strategy if the CRM is not read-only from this side

import { assertCrmConfigured, type CrmEnv } from "./base";

/**
 * Mirrors the columns in public.contracts.
 * All nullable DB columns are typed as `string | null` (or `number | null`) here
 * so callers know they may be absent in the CRM payload.
 */
export interface ContractRecord {
  contract_number: string;
  task_order_number: string | null;
  vehicle: string | null;
  client_name: string;
  client_agency: string | null;
  contract_type: string | null;
  set_aside: string | null;
  total_value: number | null;
  obligated_value: number | null;
  option_years: number | null;
  pop_start: string | null; // ISO 8601 date string
  pop_end: string | null;   // ISO 8601 date string
  status: string;
}

export interface SyncContractsOptions {
  /** ISO 8601 datetime. Only return contracts modified after this timestamp */
  since?: string;
}

/**
 * Fetch all contracts (or contracts updated since `options.since`) from the CRM
 * and return them as ContractRecord objects ready to upsert into public.contracts.
 *
 * @throws {Error} if CRM env vars are not configured
 * @throws {Error} always, until implemented (stub)
 */
export async function syncContractsFromCrm(
  env: CrmEnv,
  options?: SyncContractsOptions,
): Promise<ContractRecord[]> {
  assertCrmConfigured(env);
  // Suppress unused-variable warning until implementation lands.
  void options;
  throw new Error(
    "TODO: implement CRM contract sync. See integrations/crm/contracts.ts",
  );
}
