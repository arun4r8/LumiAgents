// TODO: Implement accounting invoice sync.
//
// This stub satisfies the type contract that orchestrations depend on.
// To implement:
//   1. Choose the target system (QuickBooks, Unanet, Deltek Vision, …)
//   2. Set ACCOUNTING_API_URL and ACCOUNTING_API_KEY via `wrangler secret put`
//   3. Replace the throw below with real HTTP calls and map the response onto InvoiceRecord
//   4. If filtering by contractId, translate it to the accounting system's project/contract ID

import { assertAccountingConfigured, type AccountingEnv } from "./base";

/**
 * Mirrors the columns in public.invoices.
 * Nullable DB columns are typed as `string | null` or `number | null`.
 */
export interface InvoiceRecord {
  contract_id: string;           // FK → public.contracts.id (UUID)
  client_name: string;
  client_agency: string | null;
  amount: number;
  amount_paid: number | null;
  invoice_date: string;          // ISO 8601 date string
  due_date: string | null;       // ISO 8601 date string
  paid_date: string | null;      // ISO 8601 date string
  status: string;                // e.g. 'draft' | 'submitted' | 'paid' | 'overdue'
  billing_period: string | null; // e.g. '2025-04' (YYYY-MM)
}

export interface SyncInvoicesOptions {
  /** UUID of the contract to filter by; omit to fetch all invoices */
  contractId?: string;
  /** ISO 8601 datetime. Only return invoices modified after this timestamp */
  since?: string;
}

/**
 * Fetch invoices from the accounting system and return them as InvoiceRecord objects
 * ready to upsert into public.invoices.
 *
 * @throws {Error} if accounting env vars are not configured
 * @throws {Error} always, until implemented (stub)
 */
export async function syncInvoicesFromAccounting(
  env: AccountingEnv,
  options?: SyncInvoicesOptions,
): Promise<InvoiceRecord[]> {
  assertAccountingConfigured(env);
  void options;
  throw new Error(
    "TODO: implement accounting invoice sync. See integrations/accounting/invoices.ts",
  );
}
