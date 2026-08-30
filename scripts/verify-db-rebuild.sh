#!/usr/bin/env bash
# ============================================================================
# verify-db-rebuild.sh  (issue #125)
#
# WHAT THIS IS
#   Proof that the repository can still reconstruct the database from nothing.
#
#   `supabase/bootstrap-fresh-project.sql` made a from-scratch rebuild possible;
#   nothing verified it STAYED possible. The next migration that quietly assumes
#   an already-migrated shape would not fail until someone next tried to rebuild
#   -- which, by definition, is during a disaster or a new-environment setup.
#   Standing up staging cost 7 sequential manual fixes for exactly this reason.
#
# WHAT IT DOES
#   1. Starts a throwaway Supabase Postgres container.
#   2. Applies the parity shim (see PARITY below).
#   3. Runs bootstrap-fresh-project.sql.
#   4. Replays every migration in supabase/migrations in filename order,
#      stopping at the first failure and naming the file.
#   5. Compares the resulting schema shape against supabase/expected-shape.json.
#
# PARITY -- why a shim is needed, and why it is only two lines
#   The container is an approximation of a real Supabase project. Two gaps are
#   artifacts of the image, NOT of this repository, and papering over anything
#   more than these would make the test dishonest:
#
#   a) auth.jwt() is absent. Every real project has it (the image ships only
#      auth.uid/role/email). Migration 20260506000001 uses it in an RLS policy,
#      so without the shim the very first migration fails for a reason that
#      would never occur on a real project.
#   b) Bootstrap does `ALTER ROLE supabase_admin ... SET search_path`, which
#      only a superuser may do. In the image `postgres` is NOT a superuser --
#      `supabase_admin` is. So the script connects as supabase_admin. On a real
#      project the SQL Editor already runs with sufficient privilege.
#
#   Nothing else is shimmed. If a migration needs anything beyond this, that is
#   a genuine finding and the build should go red.
#
# USAGE
#   scripts/verify-db-rebuild.sh                 # spin a container, verify, clean up
#   scripts/verify-db-rebuild.sh --keep          # leave the container running to poke at
#   scripts/verify-db-rebuild.sh --snapshot      # rewrite expected-shape.json from the rebuild
#   DATABASE_URL=postgresql://... scripts/verify-db-rebuild.sh --no-container
#
# EXIT CODES
#   0 = the database can still be rebuilt from the repository alone
#   1 = it cannot, or the rebuilt shape no longer matches expected-shape.json
# ============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="supabase/postgres:17.6.1.167"   # matches supabase/config.toml major_version = 17
CONTAINER="lumiagents-db-rebuild-check"
PORT="${REBUILD_CHECK_PORT:-55432}"
SHAPE_FILE="$REPO_ROOT/supabase/expected-shape.json"

KEEP=0; SNAPSHOT=0; USE_CONTAINER=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --snapshot) SNAPSHOT=1 ;;
    --no-container) USE_CONTAINER=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 1 ;;
  esac
done

cleanup() {
  if [ "$USE_CONTAINER" = "1" ] && [ "$KEEP" = "0" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ "$USE_CONTAINER" = "1" ]; then
  command -v docker >/dev/null || { echo "docker is required (or pass --no-container with DATABASE_URL)"; exit 1; }
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "Starting $IMAGE ..."
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres -p "$PORT:5432" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 3   # pg_isready goes true during init; the server restarts once after
  DB_URL="postgresql://supabase_admin:postgres@127.0.0.1:$PORT/postgres"
else
  DB_URL="${DATABASE_URL:?DATABASE_URL must be set with --no-container}"
fi

run_sql() { psql -q "$DB_URL" -v ON_ERROR_STOP=1 "$@"; }

# --- 2. parity shim (see PARITY above) --------------------------------------
echo "Applying parity shim ..."
run_sql <<'SQL' || { echo "shim failed"; exit 1; }
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
SQL

# --- 3. bootstrap -----------------------------------------------------------
echo "Running bootstrap-fresh-project.sql ..."
if ! out=$(run_sql -f "$REPO_ROOT/supabase/bootstrap-fresh-project.sql" 2>&1); then
  echo "✗ bootstrap failed:"
  echo "$out" | grep -E "ERROR|DETAIL|HINT" | head -10 | sed 's/^/    /'
  exit 1
fi

# --- 4. replay --------------------------------------------------------------
total=$(ls "$REPO_ROOT"/supabase/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ')
echo "Replaying $total migrations ..."
n=0
for f in $(ls "$REPO_ROOT"/supabase/migrations/*.sql | sort); do
  n=$((n + 1))
  if ! out=$(run_sql -f "$f" 2>&1); then
    echo ""
    echo "✗ Migration $n of $total failed: $(basename "$f")"
    echo "$out" | grep -E "ERROR|DETAIL|HINT" | head -6 | sed 's/^/    /'
    echo ""
    echo "The repository can no longer rebuild the database from scratch."
    echo "This migration assumes a shape that bootstrap-fresh-project.sql does not create."
    echo "Either make the migration self-contained, or extend the bootstrap to cover"
    echo "what it assumes. See supabase/bootstrap-fresh-project.sql."
    exit 1
  fi
done
echo "✓ all $total migrations replayed clean"

# --- 5. shape comparison ----------------------------------------------------
SHAPE_QUERY="select json_build_object(
  'orchestration_tables', (select count(*) from pg_tables where schemaname='orchestration'),
  'public_tables',        (select count(*) from pg_tables where schemaname='public'),
  'orchestration_rls_off',(select coalesce(json_agg(c.relname order by c.relname),'[]')
                             from pg_class c join pg_namespace n on n.oid=c.relnamespace
                            where n.nspname='orchestration' and c.relkind='r' and not c.relrowsecurity),
  'key_functions',        (select coalesce(json_agg(p.proname order by p.proname),'[]')
                             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                            where n.nspname='public'
                              and p.proname in ('is_ops','custom_access_token_hook','list_orchestration_tables')),
  'vector_schema',        (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='vector')
)"

actual=$(psql -tA "$DB_URL" -c "$SHAPE_QUERY")

if [ "$SNAPSHOT" = "1" ]; then
  echo "$actual" | python3 -m json.tool > "$SHAPE_FILE"
  echo "✓ wrote $SHAPE_FILE"
  exit 0
fi

python3 - "$SHAPE_FILE" <<PY
import json, sys
expected = json.load(open(sys.argv[1]))
actual = json.loads('''$actual''')
drift = [(k, expected[k], actual.get(k)) for k in expected if expected[k] != actual.get(k)]
if not drift:
    print("✓ rebuilt schema shape matches supabase/expected-shape.json")
    sys.exit(0)
print("")
print("✗ the rebuild succeeded but the resulting shape changed:")
for k, exp, got in drift:
    print(f"    {k}")
    print(f"       expected: {json.dumps(exp)}")
    print(f"       actual:   {json.dumps(got)}")
print("")
print("If this change is intended, re-snapshot and commit the result so the diff")
print("is reviewed like any other change:")
print("    scripts/verify-db-rebuild.sh --snapshot")
sys.exit(1)
PY
