#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/mysite"
RUN_DIR="$APP_DIR/.run"
PID_FILE="$RUN_DIR/server.pid"
LOG_FILE="$RUN_DIR/server.log"

mkdir -p "$RUN_DIR"
cd "$APP_DIR"

if [[ -f "$APP_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env"
  set +a
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "already-running:$old_pid"
    exit 0
  fi
fi

nohup env PORT=3000 node index.js >>"$LOG_FILE" 2>&1 < /dev/null &
new_pid=$!
echo "$new_pid" > "$PID_FILE"
sleep 1

echo "started:$new_pid"
