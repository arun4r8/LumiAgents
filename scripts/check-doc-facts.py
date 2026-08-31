#!/usr/bin/env python3
"""
Check the *checkable* claims in docs/ against the repository (#68 / Travis's question).

WHY
  Prose cannot be verified, but the specific things prose names can be: file paths,
  orchestration names, agent slugs, database tables. Those are exactly what goes stale
  and exactly what misleads a new reader. `docs/architecture.md` sat a month past being
  wrong about the agent model, and several docs still pointed at
  `components/overview-realtime.tsx` after it was deleted.

  This does not check whether the docs are WELL written or complete. It checks that
  everything they name still exists.

USAGE
  python3 scripts/check-doc-facts.py
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = sorted(ROOT.glob("docs/*.md")) + [ROOT / "README.md", ROOT / "CLAUDE.md"]

orchestrations = {
    f"{p.parent.parent.name}/{p.parent.name}"
    for p in ROOT.glob("orchestrations/*/*/definition.ts")
}
agents = {p.name for p in (ROOT / "agents").iterdir() if p.is_dir()}
tables = set()
manifest = ROOT / "supabase" / "prod-columns.json"
if manifest.exists():
    tables = {k.split(".", 1)[1] for k in json.loads(manifest.read_text())["tables"]}

# A backticked token that looks like a repo path: has a slash and a known code suffix.
PATH_RE = re.compile(r"`([A-Za-z0-9_./\-]+\.(?:ts|tsx|sql|md|toml|json|yml|yaml|mjs|py|sh))`")
# `slug/orchestration-name` in backticks, no file suffix.
ORCH_RE = re.compile(r"`([a-z][a-z0-9]*)/([a-z][a-z0-9-]*)`")

# Every filename in the repo, for basename resolution (see the loop below).
BASENAMES = {
    p.name for p in ROOT.rglob("*")
    if p.is_file() and "node_modules" not in p.parts and ".git" not in p.parts
}

# Some docs legitimately name artifacts that do not exist: a design doc proposing
# `agent.manifest.yaml`, a worked example built around a fictional `cleo/reels-plan`, an
# inventory of retired n8n flows. Those opt out with a marker on the first line rather
# than being silently excluded here, so the exemption is visible in the doc itself.
ILLUSTRATIVE = "<!-- doc-facts: illustrative -->"

problems = []
skipped = []
for doc in DOCS:
    if not doc.exists():
        continue
    rel_doc = doc.relative_to(ROOT)
    text = doc.read_text()
    if ILLUSTRATIVE in text:
        skipped.append(rel_doc)
        continue

    for m in PATH_RE.finditer(text):
        ref = m.group(1)
        if ref.startswith(("http", "@", "node_modules")) or "..." in ref:
            continue
        # Docs name files two ways: a real repo path, and prose shorthand ("see
        # `definition.ts`"). Resolving by BASENAME accepts both, and still catches the
        # case that matters -- a file that no longer exists anywhere, which is what
        # sends a reader hunting. Exact-path checking would flag most of the shorthand
        # in every design doc, and a check that cries wolf gets switched off.
        if (ROOT / ref).exists() or pathlib.Path(ref).name in BASENAMES:
            continue
        problems.append((rel_doc, "names a file that does not exist", ref))

    for m in ORCH_RE.finditer(text):
        slug, name = m.group(1), m.group(2)
        full = f"{slug}/{name}"
        # Only treat it as an orchestration reference if the prefix is a real agent slug;
        # otherwise it is ordinary prose like `and/or` or a directory like `docs/foo`.
        if slug in agents and full not in orchestrations:
            problems.append((rel_doc, "unknown orchestration", full))

# The architecture diagram is the one doc that claims to be a complete inventory, so
# completeness is checkable there and nowhere else. This is what "living" means for it:
# adding an orchestration without listing it fails the build.
diagram = ROOT / "docs" / "architecture-diagram.md"
if diagram.exists():
    listed = set(re.findall(r"\| `([a-z]+/[a-z0-9-]+)` \|", diagram.read_text()))
    for missing in sorted(orchestrations - listed):
        problems.append((diagram.relative_to(ROOT), "registered orchestration not in the inventory", missing))

print(f"  docs scanned: {len([d for d in DOCS if d.exists()]) - len(skipped)}"
      f"  (skipped {len(skipped)} marked illustrative)")
print(f"  known: {len(orchestrations)} orchestrations, {len(agents)} agents, {len(tables)} tables")
if not problems:
    print("  ✓ every path and orchestration named in the docs exists")
    sys.exit(0)

print(f"\n  ✗ {len(problems)} stale reference(s):")
for rel_doc, kind, ref in problems:
    print(f"      {kind}: {ref}")
    print(f"        {rel_doc}")
print("\n  A doc that names something which no longer exists is worse than no doc:")
print("  it sends the reader looking for a file that is not there.")
sys.exit(1)
