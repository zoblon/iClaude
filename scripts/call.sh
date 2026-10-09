#!/bin/bash
# Hilfsskript: ruft ein Tool über den MCP Inspector auf.
# Nutzung: scripts/call.sh <tool> [key=value ...]   (Werte dürfen Leerzeichen enthalten; JSON für Listen/Objekte)
set -e
tool="$1"; shift
cmd=(npx -y @modelcontextprotocol/inspector --cli ./scripts/dev-server.sh --method tools/call --tool-name "$tool")
for a in "$@"; do cmd+=(--tool-arg "$a"); done
cd "$(dirname "$0")/.."
exec "${cmd[@]}"
