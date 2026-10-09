#!/bin/sh
# Startet das GEBÜNDELTE Paket (build/stage/server/index.mjs) wie Claude Desktop es tut, mit Werten aus .env.
# Hinweis: Die Claude-App nicht im Node-Modus starten (ELECTRON_RUN_AS_NODE ist gesperrt, das würde eine zweite App-Instanz starten).
cd "$(dirname "$0")/.." || exit 1
set -a
. ./.env
set +a
exec node build/stage/server/index.mjs
