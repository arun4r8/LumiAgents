# Database

Supabase migrations for the orchestration layer.

## Running migrations

Migrations are applied via the Supabase dashboard SQL editor or via CLI once IPv6 is resolved:

```bash
# Apply a single migration manually (paste into Supabase SQL editor)
# Dashboard: https://supabase.com/dashboard/project/jlljpgdqqxljvznjslmb/sql

# Or via CLI (requires direct Postgres — needs IPv4/pooler):
supabase db push
```

## Migration order

| File | What it does |
|------|-------------|
| `0001_orchestration_schema.sql` | Creates `orchestration` schema with all 7 tables + RLS |
| `0002_supabase_auth_migration.sql` | Adds `auth_id` to `public.users`, enables RLS, prepares for Supabase Auth |

## Rules

- Never edit an applied migration. Add a new one.
- Every new table must have RLS enabled in the same migration.
- Rollback is a comment, not executable code. Rollback is a deliberate human act.
