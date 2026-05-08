"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";

type TableName =
  | "contracts"
  | "budget_lines"
  | "invoices"
  | "labor_records"
  | "indirect_rates"
  | "employees"
  | "past_performance";

// Allowed tables for writes — explicit allowlist, never interpolate user input directly
const WRITABLE_TABLES: ReadonlySet<TableName> = new Set([
  "contracts",
  "budget_lines",
  "invoices",
  "labor_records",
  "indirect_rates",
  "employees",
  "past_performance",
]);

function assertWritable(table: string): asserts table is TableName {
  if (!WRITABLE_TABLES.has(table as TableName)) {
    throw new Error(`Table "${table}" is not writable via this action`);
  }
}

export async function insertRow(
  table: string,
  data: Record<string, unknown>,
): Promise<{ error?: string }> {
  assertWritable(table);
  const supabase = await createClient();
  const { error } = await supabase.from(table).insert(data);
  if (error) return { error: error.message };
  revalidatePath("/data");
  return {};
}

export async function bulkInsert(
  table: string,
  rows: Record<string, unknown>[],
): Promise<{ inserted: number; error?: string }> {
  assertWritable(table);
  if (rows.length === 0) return { inserted: 0 };

  const supabase = await createClient();
  const { error } = await supabase.from(table).insert(rows);

  if (error) return { inserted: 0, error: error.message };
  revalidatePath("/data");
  return { inserted: rows.length };
}

export async function deleteRow(
  table: string,
  id: string,
): Promise<{ error?: string }> {
  assertWritable(table);
  const supabase = await createClient();
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) return { error: error.message };
  revalidatePath("/data");
  return {};
}
