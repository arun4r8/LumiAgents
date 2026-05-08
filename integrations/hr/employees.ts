// TODO: Implement HR employee sync.
//
// This stub satisfies the type contract that orchestrations depend on.
// To implement:
//   1. Choose the target HR system (BambooHR, Workday, ADP, …)
//   2. Set HR_API_URL and HR_API_KEY via `wrangler secret put`
//   3. Replace the throw below with real HTTP calls and map the HR response
//      fields onto EmployeeRecord
//   4. Handle pagination — most HR APIs return results in pages of 50–100

import { assertHrConfigured, type HrEnv } from "./base";

/**
 * Mirrors the columns in public.employees.
 * Nullable DB columns are typed as `string | null` here.
 */
export interface EmployeeRecord {
  full_name: string;
  email: string;
  title: string | null;
  department: string | null;
  start_date: string | null;  // ISO 8601 date string
  end_date: string | null;    // ISO 8601 date string; null if still employed
  status: string;             // e.g. 'active' | 'inactive' | 'on_leave'
  employment_type: string | null; // e.g. 'full_time' | 'part_time' | 'contractor'
  clearance_level: string | null; // e.g. 'none' | 'secret' | 'top_secret'
}

export interface SyncEmployeesOptions {
  /** When true, only return employees with status = 'active' */
  activeOnly?: boolean;
}

/**
 * Fetch all employees (or only active ones) from the HR system and return them
 * as EmployeeRecord objects ready to upsert into public.employees.
 *
 * @throws {Error} if HR env vars are not configured
 * @throws {Error} always, until implemented (stub)
 */
export async function syncEmployeesFromHr(
  env: HrEnv,
  options?: SyncEmployeesOptions,
): Promise<EmployeeRecord[]> {
  assertHrConfigured(env);
  void options;
  throw new Error(
    "TODO: implement HR employee sync — see integrations/hr/employees.ts",
  );
}
