#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/dev-all-once.sh <port>
PORT="${1:-63000}"
ROOT="${ROOT:-.}"
DB_PATH="${DB_PATH:-}"
WEB_DIR="${WEB_DIR:-packages/web}"
SERVER_BIN="${SERVER_BIN:-ailoom-server}"

cleanup() {
  echo "[dev-all-once] 退出，清理后端进程..."
  pkill -f "${SERVER_BIN}.*--port ${PORT}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 启动后端（不监听、只提供 API，不托管静态资源）
RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" \
cargo run -p ${SERVER_BIN} --bin ${SERVER_BIN} -- --root "${ROOT}" --no-static --port ${PORT} ${DB_PATH:+--db-path "$DB_PATH"} &
SRV_PID=$!

echo "[dev-all-once] 后端 API: http://127.0.0.1:${PORT} (no static)"
echo "[dev-all-once] 前端 Dev: http://localhost:5173 (WS 默认开启；如需禁用：VITE_USE_WS=0)"

# 启动前端 Dev，指向后端
VITE_API_BASE="http://127.0.0.1:${PORT}" \
pnpm -C "${WEB_DIR}" dev || true

# 前端退出，清理后端
cleanup
