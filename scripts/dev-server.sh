#!/bin/sh
# Starts the server for development and Inspector tests.
# Loads .env itself so credentials never appear as command-line arguments.
cd "$(dirname "$0")/.." || exit 1
set -a
. ./.env
set +a
exec npx tsx src/stdio.ts
