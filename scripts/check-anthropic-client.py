#!/usr/bin/env python3
"""
Every Anthropic client must come from integrations/anthropic/client.ts.

WHY
  Twelve call sites each did `new Anthropic({ apiKey })` with no timeout and no retry
  bound. The SDK defaults to a 10-minute timeout and 2 retries, so one stalled request
  holds a step for ~30 minutes and is then retried again by the durable Workflow path.

  Observed: beady/govcon-assessment's `executive-memo` step -- max_tokens 1024, an 8KB
  prompt, 13 seconds an hour earlier -- sat "running" for 36 minutes with no error, no
  output and nothing in the logs. A silent hang is worse than a failure: nothing alerts,
  the UI still says "running", and you only find it by going to look.

  `anthropicClient()` bounds it and lets a genuinely long call raise its own timeout.

USAGE
  python3 scripts/check-anthropic-client.py
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FACTORY = ROOT / "integrations" / "anthropic" / "client.ts"
SEARCH = ["integrations", "runtime/src", "orchestrations", "agents", "dashboard"]

offenders = []
scanned = 0
for base in SEARCH:
    for path in (ROOT / base).rglob("*.ts"):
        if "node_modules" in path.parts or path == FACTORY:
            continue
        scanned += 1
        text = path.read_text()
        for i, line in enumerate(text.splitlines(), 1):
            if re.search(r"new\s+Anthropic\s*\(", line):
                offenders.append((path.relative_to(ROOT), i, line.strip()[:88]))

print(f"  scanned {scanned} files")
if not offenders:
    print("  ✓ every Anthropic client comes from integrations/anthropic/client.ts")
    sys.exit(0)

print(f"\n  ✗ {len(offenders)} direct Anthropic construction(s):")
for rel, line_no, snippet in offenders:
    print(f"      {rel}:{line_no}")
    print(f"        {snippet}")
print("\n  A client built without a timeout can hang a run for ~30 minutes with no error.")
print("  Use `anthropicClient(apiKey)` from integrations/anthropic/client.ts;")
print("  pass { timeoutMs } if this particular call genuinely needs longer.")
sys.exit(1)
