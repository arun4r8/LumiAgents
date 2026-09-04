#!/usr/bin/env python3
"""
No server-side code may fetch the runtime Worker over plain HTTP.

WHY
  A Worker cannot fetch another Worker on the same zone -- Cloudflare refuses the
  subrequest with error 1042. In production that surfaced as a bare 404 body reading
  "error code: 1042", and because server errors are redacted in production builds the
  user saw only "An error occurred in the Server Components render".

  Every server-side call from the dashboard into the runtime was failing that way:
  Run-a-sweep, RFI drafting, content draft/plan/sync, resume redaction, Tier 2
  proposals, schedules, the Knowledge document list, and -- worst -- responding to an
  approval. It worked in local dev, where the caller is Node rather than a Worker, so
  nothing ever looked broken while developing.

  Server code must go through lib/runtime-fetch.ts, which dispatches over the
  RUNTIME_WORKER Service Binding when one is present.

  CLIENT components are exempt: a browser fetch to the runtime is an ordinary
  cross-origin request and is unaffected by 1042.

USAGE
  python3 scripts/check-runtime-fetch.py
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DASH = ROOT / "dashboard"
ALLOWED = {DASH / "lib" / "runtime-fetch.ts"}

offenders = []
scanned = 0
for path in list((DASH / "app").rglob("*.ts")) + list((DASH / "app").rglob("*.tsx")) \
          + list((DASH / "lib").rglob("*.ts")) + list((DASH / "lib").rglob("*.tsx")) \
          + list((DASH / "components").rglob("*.ts")) + list((DASH / "components").rglob("*.tsx")):
    if "node_modules" in path.parts or path in ALLOWED:
        continue
    text = path.read_text()
    # A client component runs in the browser, where 1042 does not apply.
    if re.match(r'^\s*(?://.*\n|\s*\n)*\s*["\']use client["\']', text):
        continue
    scanned += 1
    if "NEXT_PUBLIC_RUNTIME_URL" in text:
        for i, line in enumerate(text.splitlines(), 1):
            if "NEXT_PUBLIC_RUNTIME_URL" in line:
                offenders.append((path.relative_to(ROOT), i, line.strip()[:90]))

print(f"  scanned {scanned} server-side dashboard files")
if not offenders:
    print("  ✓ all server-side runtime calls go through lib/runtime-fetch.ts")
    sys.exit(0)

print(f"\n  ✗ {len(offenders)} server-side reference(s) to NEXT_PUBLIC_RUNTIME_URL:")
for rel, line_no, snippet in offenders:
    print(f"      {rel}:{line_no}")
    print(f"        {snippet}")
print("\n  A Worker cannot fetch another Worker on the same zone (Cloudflare 1042).")
print("  Use `fetchRuntime(\"/api/...\")` from @/lib/runtime-fetch instead.")
print("  If this file is a client component, give it a \"use client\" directive.")
sys.exit(1)
