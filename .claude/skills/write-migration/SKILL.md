---
name: write-migration
description: Use when adding, altering, or removing Supabase tables, columns, indexes, or RLS policies. Trigger on "add a table", "new column", "schema change", "RLS policy", "migration", "alter table", or any request that changes the database shape.
---

# Writing a Supabase migration

Migrations are forward-only. Never edit an applied migration. Add a new one.

## Before writing

Confirm with the user:
- What's the change in plain English?
- What rows exist today that will be affected? (Read the table first if uncertain.)
- What happens to in-flight runs if this ships? (Required note in PR description for any change to the `orchestration` schema.)
- Does this need a backfill? If so, is it safe to run online or does it need a maintenance window?

## File location and naming

`db/migrations/YYYYMMDDHHMM_<short_description>.sql` — timestamp prefix, snake_case description.

## Required structure

```sql
-- Migration: <short description>
-- Issue: #<issue-number>
-- Author: <name>
--
-- What changes:
--   <one paragraph>
--
-- Migration story for in-flight runs:
--   <how existing runs are affected; "no impact" is a valid answer if true>
--
-- Rollback (manual, do not run automatically):
--   <SQL to undo>

BEGIN;

-- DDL here
CREATE TABLE orchestration.foo (...);

-- RLS in the SAME migration as the table
ALTER TABLE orchestration.foo ENABLE ROW LEVEL SECURITY;

CREATE POLICY foo_ops_all ON orchestration.foo
  FOR ALL TO authenticated
  USING (auth.jwt()->>'role' = 'ops');

CREATE POLICY foo_enduser_select ON orchestration.foo
  FOR SELECT TO authenticated
  USING (
    auth.jwt()->>'role' = 'enduser'
    AND <whatever the visibility rule is>
  );

-- Backfill, if any
UPDATE orchestration.foo SET ...;

COMMIT;
```

## Hard rules

- New table → RLS enabled in same migration. No exceptions.
- New table → at least one ops policy and one enduser policy (or an explicit comment why end users have no access).
- Indexes for any column used in an RLS policy's USING clause. Otherwise RLS becomes a sequential scan on every query.
- Columns added to existing tables: nullable or with a DEFAULT. No NOT NULL without DEFAULT on a populated table.
- Renames: split into "add new column", backfill, "switch readers", "drop old column" — across multiple migrations and PRs. Never rename in one shot.
- Foreign keys: always `ON DELETE` explicitly chosen (RESTRICT / CASCADE / SET NULL). Don't accept the default.

## Soft rules

- Prefer `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` so the migration is replay-safe.
- One logical change per migration. If you have two unrelated changes, write two migrations.
- Functions and triggers belong in their own migrations, separate from table changes.

## Testing locally

```sh
# from repo root
pnpm db:reset       # drops local DB and re-applies all migrations
pnpm db:test-rls    # runs the RLS test suite with both ops and enduser JWTs
```

If `db:test-rls` doesn't have a case covering your new table, add one before merging.

## Gotchas

- `auth.jwt()` is not available in service-role connections. RLS policies that reference it will return false for service role, which is fine because service role bypasses RLS — but it's confusing to debug.
- Adding a NOT NULL column with a DEFAULT on a large table can lock the table briefly. For tables with millions of rows, do it in two migrations (add nullable, backfill, then alter to NOT NULL).
- Supabase replicas can lag. After a migration, the realtime subscriptions in the dashboard may temporarily show stale data. Document this if it matters for the change.
- `DROP COLUMN` removes data permanently. Always check with the user before writing one.
