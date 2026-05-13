-- Forward-proof the public schema against the Supabase May-30 change:
-- new tables in `public` will no longer be auto-exposed to the Data API.
-- ALTER DEFAULT PRIVILEGES means any table created by the postgres role in
-- `public` is automatically granted to service_role and authenticated,
-- so future migrations don't need a per-table GRANT.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT ON TABLES TO authenticated;

-- Sequences (needed for serial/identity columns)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE ON SEQUENCES TO authenticated;

-- Functions (covers RPCs)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO service_role;
