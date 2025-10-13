#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/cleanup-dev.sh [port]
PORT="${1:-63000}"
ROOT="${ROOT:-$(pwd)}"
SERVER_BIN="${SERVER_BIN:-ailoom-server}"

echo "[cleanup] root=${ROOT} port=${PORT}"

# 1) 停掉 dev-all 记录的 cargo-watch
if [[ -f .ailoom/dev-all.pid ]]; then
  WATCH_PID=$(cat .ailoom/dev-all.pid || true)
  if [[ -n "${WATCH_PID}" ]]; then
    echo "[cleanup] kill cargo-watch pid=${WATCH_PID}"
    kill "${WATCH_PID}" 2>/dev/null || true
  fi
  rm -f .ailoom/dev-all.pid
fi

# 2) 杀掉从当前工作目录启动的 ailoom-server（兜底）
echo "[cleanup] kill ailoom-server started from this repo (if any)"
pkill -f "${ROOT}.*${SERVER_BIN}" 2>/dev/null || true

# 3) 如端口仍被占用，强制释放端口
PIDS=$(lsof -t -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "${PIDS:-}" ]]; then
  echo "[cleanup] force kill port ${PORT} pids: ${PIDS}"
  kill -9 ${PIDS} 2>/dev/null || true
fi

echo "[cleanup] done"
