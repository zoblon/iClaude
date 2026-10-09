#!/bin/sh
# Starts the BUNDLED package (build/stage/server/index.mjs) the way Claude Desktop does, with values from .env.
# Note: do not start the Claude app in Node mode (ELECTRON_RUN_AS_NODE is blocked; it would start a second app instance).
cd "$(dirname "$0")/.." || exit 1
set -a
. ./.env
set +a
exec node build/stage/server/index.mjs
