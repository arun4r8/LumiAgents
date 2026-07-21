// TODO: Implement accounting budget-line sync.
//
// This stub satisfies the type contract that orchestrations depend on.
// To implement:
//   1. Choose the target system (QuickBooks, Unanet, Deltek Vision, …)
//   2. Set ACCOUNTING_API_URL and ACCOUNTING_API_KEY via `wrangler secret put`
//   3. Replace the throw below with real HTTP calls and map the response onto BudgetLineRecord
//   4. Translate contractId to the accounting system's project/contract identifier

import { assertAccountingConfigured, type AccountingEnv } from "./base";

/**
 * Mirrors the columns in public.budget_lines.
 * Nullable DB columns are typed as `string | null` or `number | null`.
 */
export interface BudgetLineRecord {
  contract_id: string;        // FK → public.contracts.id (UUID)
  clin: string | null;        // Contract Line Item Number
  description: string | null;
  category: string | null;    // e.g. 'labor' | 'materials' | 'subcontractor' | 'overhead'
  fiscal_year: string | null; // e.g. '2025'
  budgeted: number | null;
  obligated: number | null;
  expended: number | null;
  remaining: number | null;
  notes: string | null;
}

/**
 * Fetch all budget lines for a given contract from the accounting system and return
 * them as BudgetLineRecord objects ready to upsert into public.budget_lines.
 *
 * @param contractId  UUID of the contract in public.contracts
 * @throws {Error} if accounting env vars are not configured
 * @throws {Error} always, until implemented (stub)
 */
export async function syncBudgetLinesFromAccounting(
  env: AccountingEnv,
  contractId: string,
): Promise<BudgetLineRecord[]> {
  assertAccountingConfigured(env);
  void contractId;
  throw new Error(
    "TODO: implement accounting budget-line sync. See integrations/accounting/budget-lines.ts",
  );
}
