#!/bin/sh
# Startet den Server für Entwicklung und Inspector-Tests.
# Lädt .env selbst, damit Zugangsdaten nie als Kommandozeilenargument auftauchen.
cd "$(dirname "$0")/.." || exit 1
set -a
. ./.env
set +a
exec npx tsx src/stdio.ts
