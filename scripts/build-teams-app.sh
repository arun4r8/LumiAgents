#!/usr/bin/env bash
#
# Build the Teams app package (#162).
#
# Adding the Microsoft Teams CHANNEL to the Azure Bot resource makes the bot
# reachable by Teams infrastructure. It does NOT make the bot installable by a
# human -- that needs this package. The setup comment in integrations/teams/bot.ts
# documented steps 1-5 and stopped there, which is why the bot sat unreachable for
# months while looking configured: a deep link to it answers
#
#   "You do not have permission to use this app here."
#
# The bot's app id is injected rather than committed. It is not a secret, but it
# differs between the production and staging bot registrations, and a manifest with
# one baked in is a manifest someone will upload to the wrong tenant.
#
# Usage:
#   scripts/build-teams-app.sh <TEAMS_BOT_APP_ID> [output.zip]
#
# Then either:
#   * Teams -> Apps -> Manage your apps -> Upload an app -> Upload a custom app
#     (needs custom-app upload enabled in the Teams admin app-setup policy), or
#   * Teams admin center -> Teams apps -> Manage apps -> Upload new app
#     (publishes org-wide; the app then appears under "Built for your org").

set -euo pipefail

APP_ID="${1:-}"
OUT="${2:-teams-app/lumiagents-teams-app.zip}"

if [[ -z "$APP_ID" ]]; then
  echo "usage: $0 <TEAMS_BOT_APP_ID> [output.zip]" >&2
  echo "  find it at portal.azure.com -> App registrations -> LumiAgents Bot -> Application (client) ID" >&2
  exit 1
fi

# A wrong id produces an app that installs and then never responds, which is the
# single most expensive failure here -- it looks like success. Check the shape.
if [[ ! "$APP_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "error: '$APP_ID' is not a GUID. Expected the Application (client) ID." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/teams-app"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

sed "s/__TEAMS_BOT_APP_ID__/$APP_ID/g" "$SRC/manifest.json" > "$BUILD/manifest.json"
cp "$SRC/color.png" "$SRC/outline.png" "$BUILD/"

# Fail loudly if a placeholder survived, rather than shipping a package that
# installs as a bot with the literal id "__TEAMS_BOT_APP_ID__".
if grep -q "__TEAMS_BOT_APP_ID__" "$BUILD/manifest.json"; then
  echo "error: placeholder still present after substitution" >&2
  exit 1
fi
python3 -c "import json,sys; json.load(open('$BUILD/manifest.json'))" || {
  echo "error: substitution produced invalid JSON" >&2; exit 1; }

mkdir -p "$(dirname "$ROOT/$OUT")"
# Zip from INSIDE the build dir: Teams requires manifest.json at the archive root,
# and zipping the directory itself nests everything one level down and is rejected
# with a message that does not mention nesting.
( cd "$BUILD" && zip -q -X "$ROOT/$OUT" manifest.json color.png outline.png )

echo "built $OUT"
unzip -l "$ROOT/$OUT" | sed 's/^/  /'
