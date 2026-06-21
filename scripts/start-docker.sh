#!/bin/sh
set -eu

PORT="${PORT:-8787}"
PERSIST_TO="${PERSIST_TO:-/data/wrangler}"
WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/wrangler.log}"

mkdir -p "$PERSIST_TO" "$(dirname "$WRANGLER_LOG_PATH")"

exec pnpm exec wrangler dev dist/server/index.js \
  --config dist/server/wrangler.json \
  --ip 0.0.0.0 \
  --port "$PORT" \
  --inspector-ip 127.0.0.1 \
  --inspector-port 0 \
  --persist-to "$PERSIST_TO" \
  --log-level info \
  --show-interactive-dev-session false
