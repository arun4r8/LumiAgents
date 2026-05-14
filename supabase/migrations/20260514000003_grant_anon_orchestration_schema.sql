-- PostgREST checks schema accessibility against the `anon` role before
-- switching to `authenticated` when a valid JWT is present. Without this
-- grant, every request to the orchestration schema returns 42501 even for
-- logged-in users, because PostgREST validates the schema path first.
GRANT USAGE ON SCHEMA orchestration TO anon;
GRANT USAGE ON SCHEMA orchestration TO authenticated;
