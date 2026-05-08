// TODO: Implement accounting labor-record sync.
//
// This stub satisfies the type contract that orchestrations depend on.
// To implement:
//   1. Choose the target system (QuickBooks, Unanet, Deltek Vision, …)
//   2. Set ACCOUNTING_API_URL and ACCOUNTING_API_KEY via `wrangler secret put`
//   3. Replace the throw below with real HTTP calls and map timesheet/labor data
//      onto LaborRecord
//   4. Handle pagination — labor APIs often return large result sets

import { assertAccountingConfigured, type AccountingEnv } from "./base.ts";

/**
 * Mirrors the columns in public.labor_records.
 * Nullable DB columns are typed as `string | null` or `number | null`.
 */
export interface LaborRecord {
  employee_id: string | null;      // FK → public.employees.id (UUID), if resolvable
  employee_name: string;
  contract_id: string | null;      // FK → public.contracts.id (UUID), if resolvable
  contract_number: string | null;
  clin: string | null;             // Contract Line Item Number
  work_date: string;               // ISO 8601 date string
  hours: number;
  labor_category: string | null;   // e.g. 'senior_engineer' | 'program_manager'
  hourly_rate: number | null;
  charge_type: string | null;      // e.g. 'direct' | 'indirect' | 'unallowable'
}

export interface SyncLaborRecordsOptions {
  /** UUID of the contract to filter by — omit to fetch across all contracts */
  contractId?: string;
  /** YYYY-MM — only return labor records for this calendar month */
  month?: string;
}

/**
 * Fetch labor records from the accounting system and return them as LaborRecord objects
 * ready to upsert into public.labor_records.
 *
 * @throws {Error} if accounting env vars are not configured
 * @throws {Error} always, until implemented (stub)
 */
export async function syncLaborRecordsFromAccounting(
  env: AccountingEnv,
  options?: SyncLaborRecordsOptions,
): Promise<LaborRecord[]> {
  assertAccountingConfigured(env);
  void options;
  throw new Error(
    "TODO: implement accounting labor-record sync — see integrations/accounting/labor-records.ts",
  );
}
