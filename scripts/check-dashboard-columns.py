#!/usr/bin/env python3
"""
Validate every dashboard `.from(table).select(cols)` against a real schema (#68).

WHY
  The dashboard talks to PostgREST with string column lists. TypeScript cannot check
  them, so a column that is renamed or never existed fails at RUNTIME as a 400 and the
  panel renders empty. That is invisible in review and often invisible in the product
  too: `knowledge/page.tsx` selected `runs.completed_at` (the column is `ended_at`) and
  nobody noticed, because the orchestration it lists has never run -- the panel would
  have been empty either way.

SOURCE OF TRUTH
  supabase/prod-columns.json -- a manifest of PRODUCTION's columns. Anchored to
  production because that is what the dashboard actually queries. Deliberately NOT a
  fresh rebuild: the bootstrap still creates stub shapes for the legacy tables (174
  columns across 19 tables are missing from a rebuild, see #180), so checking against
  one would flag correct dashboard code as broken.

  Regenerate with scripts/snapshot-prod-columns.sh when the production schema changes;
  the diff is then reviewed like any other change.

USAGE
  python3 scripts/check-dashboard-columns.py

Exits non-zero and names file, table and column for each bad reference.
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "supabase" / "prod-columns.json"

# The dashboard addresses tables unqualified (it sets .schema() separately), so fold the
# manifest's schema-qualified keys down to bare table names. Two same-named tables in
# different schemas would merge -- there are none today, and the guard below asserts it.
raw = json.loads(MANIFEST.read_text())["tables"]
bare = [k.split(".", 1)[1] for k in raw]
assert len(bare) == len(set(bare)), "same table name in two schemas; this checker needs qualifying"
schema = {k.split(".", 1)[1]: set(v) for k, v in raw.items()}

# The manifest is a snapshot of PRODUCTION, so a column added by a migration in this
# same branch is not in it yet -- and adding a column and using it in one change is the
# normal workflow, not an error. Union in whatever the repo's own migrations add, so the
# check means "exists in production, or will once this branch is deployed".
#
# Deliberately additive only: this can make the check more permissive, never stricter,
# so a genuinely missing column is still caught.
ADD_COLUMN = re.compile(
    r"ALTER\s+TABLE\s+(?:public\.)?(\w+)(.*?);",
    re.I | re.S,
)
COLUMN_NAME = re.compile(r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", re.I)
for sql_file in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
    text = sql_file.read_text()
    for m in ADD_COLUMN.finditer(text):
        table, body = m.group(1), m.group(2)
        cols = COLUMN_NAME.findall(body)
        if cols:
            schema.setdefault(table, set()).update(cols)

# `.from("t").select("a, b, rel(x, y), alias:c")`
CALL = re.compile(r'\.from\(\s*["\']([a-z_]+)["\']\s*\)\s*(?:\.\w+\([^)]*\)\s*)*?\.select\(\s*["\']([^"\']+)["\']')

def bare_columns(select_str: str):
    """Top-level columns only: embedded relations rel(...) belong to another table, and
    `alias:col` renames the OUTPUT, so the real column is the right-hand side."""
    out, depth, buf = [], 0, ""
    for ch in select_str:
        if ch == "(":
            depth += 1
            buf = ""          # `rel(` -- drop the relation name and everything inside
        elif ch == ")":
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(buf); buf = ""
        elif depth == 0:
            buf += ch
    out.append(buf)
    cols = []
    for c in out:
        c = c.strip()
        if not c or c == "*":
            continue
        if ":" in c:
            c = c.split(":", 1)[1].strip()
        if re.fullmatch(r"[a-z_][a-z0-9_]*", c):
            cols.append(c)
    return cols

bad = []
files = list(ROOT.joinpath("dashboard").rglob("*.tsx")) + list(ROOT.joinpath("dashboard").rglob("*.ts"))
checked = 0
for path in files:
    if "node_modules" in str(path):
        continue
    text = path.read_text()
    for m in CALL.finditer(text):
        table, sel = m.group(1), m.group(2)
        checked += 1
        rel = path.relative_to(ROOT)
        if table not in schema:
            bad.append((rel, table, "(table does not exist)"))
            continue
        for col in bare_columns(sel):
            if col not in schema[table]:
                bad.append((rel, table, col))

print(f"  checked {checked} .select() call sites against {len(schema)} production tables")
if not bad:
    print("  ✓ every dashboard column reference resolves")
    sys.exit(0)
print(f"\n  ✗ {len(bad)} dashboard column reference(s) do not exist:")
for rel, table, col in bad:
    print(f"      {table}.{col}")
    print(f"        {rel}")
print("\n  PostgREST returns 400 for these, so the query fails and the panel renders empty.")
sys.exit(1)
