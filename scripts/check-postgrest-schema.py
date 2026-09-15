#!/usr/bin/env python3
"""
Guard: PostgREST selects a schema by HEADER, never by a dotted path.

    WRONG   /rest/v1/orchestration.approvals
    RIGHT   /rest/v1/approvals   + Accept-Profile / Content-Profile: orchestration

Both forms look plausible, and the wrong one does not fail loudly: PostgREST 404s,
a caller that skips `res.ok` parses the error body as an object, and an empty result
reads as "no rows yet". `approval.ts` polled a 404 for 48 hours that way (#223).

`runtime/src/utils/supabase.ts` has `sbHeaders(env, { profile })`; use it.
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
# /rest/v1/<something>.<something> where the first part is a bare identifier.
BAD = re.compile(r"/rest/v1/([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)")
# The same mistake with the base URL held in a variable: `${base}/orchestration.x`.
# The literal /rest/v1/ never appears, which is how
# runtime/src/agents/vault-sync.ts carried one past this guard (#181). Limited to
# the non-public schemas PostgREST exposes, so `${dir}/file.ts` is not flagged.
NON_PUBLIC_SCHEMAS = ("orchestration",)
BAD_TEMPLATED = re.compile(r"\$\{[^}]+\}/(" + "|".join(NON_PUBLIC_SCHEMAS) + r")\.([a-z_][a-z0-9_]*)")
SKIP = {"node_modules", ".git", ".next", ".open-next", "dist"}

bad = []
scanned = 0
for path in ROOT.rglob("*.ts*"):
    if any(part in SKIP for part in path.parts):
        continue
    scanned += 1
    for i, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
        m = BAD.search(line) or BAD_TEMPLATED.search(line)
        if m:
            bad.append((path.relative_to(ROOT), i, m.group(0)))

print(f"  scanned {scanned} files")
if bad:
    print("  ✗ schema-qualified PostgREST paths (use sbHeaders(env, {{profile}}) instead):")
    for f, i, frag in bad:
        print(f"      {f}:{i}  {frag}")
    sys.exit(1)
print("  ✓ no schema-qualified PostgREST paths")
