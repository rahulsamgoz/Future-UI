#!/usr/bin/env bash
# Start the API service and index worker in the background with logs in
# infra/dev/logs/. Prints the endpoints when ready.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

LOG_DIR="infra/dev/logs"
mkdir -p "$LOG_DIR"

DB_PATH="${UI_INTEL_DB:-./data/ui-intelligence.sqlite}"
STORE_DIR="${UI_INTEL_STORE:-./data/artifacts}"
API_PORT="${PORT:-8787}"
TOKEN="${UI_INTEL_TOKEN:-dev-token}"

# Build if the entrypoints are missing.
if [ ! -f apps/api/dist/server.js ]; then
  echo "Building apps/api..."
  npx tsc -b apps/api
fi
if [ ! -f apps/index-worker/dist/main.js ]; then
  echo "Building apps/index-worker..."
  npx tsc -b apps/index-worker
fi

start() {
  local name="$1"; shift
  local pattern="$1"; shift
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo "$name appears to be running already; skipping"
    return
  fi
  echo "Starting $name (log: $LOG_DIR/$name.log)"
  nohup "$@" >>"$LOG_DIR/$name.log" 2>&1 &
  echo $! >"$LOG_DIR/$name.pid"
}

start api "node .*apps/api/dist/server.js" env \
  UI_INTEL_DB="$DB_PATH" UI_INTEL_STORE="$STORE_DIR" UI_INTEL_TOKEN="$TOKEN" PORT="$API_PORT" \
  node apps/api/dist/server.js

start index-worker "node .*apps/index-worker/dist/main.js" env \
  UI_INTEL_DB="$DB_PATH" UI_INTEL_SCHEMA="$ROOT/infra/dev/schema.sql" \
  node apps/index-worker/dist/main.js

sleep 1

cat <<EOF

UI Intelligence dev services
  API:          http://localhost:$API_PORT  (health: /health)
  Auth:         Authorization: Bearer $TOKEN
  SQLite db:    $DB_PATH
  Object store: $STORE_DIR
  Logs:         $LOG_DIR/{api,index-worker}.log
  Stop:         kill \$(cat $LOG_DIR/api.pid) \$(cat $LOG_DIR/index-worker.pid)
EOF
