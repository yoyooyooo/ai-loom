#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/dev-all.sh <port>
PORT="${1:-63000}"
ROOT="${ROOT:-.}"
WEB_DIR="${WEB_DIR:-packages/web}"
WEB_DIST="${WEB_DIST:-packages/web/dist}"
SERVER_BIN="${SERVER_BIN:-ailoom-server}"

if ! cargo watch -V >/dev/null 2>&1; then
  echo '未检测到 cargo-watch，请先安装：cargo install cargo-watch'
  exit 1
fi

mkdir -p .ailoom

cleanup() {
  # 退出时再次提示前端访问地址，避免被日志刷掉
  echo "[dev-all] 前端访问: http://localhost:5173"
  # 停止 cargo-watch
  if [[ -n "${WATCH_PID:-}" ]]; then
    kill "${WATCH_PID}" 2>/dev/null || true
  fi
  # 兜底：终止当前端口上的后端进程（防止残留）
  pkill -f "${SERVER_BIN}.*--port ${PORT}" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# 仅监听 Rust 目录，忽略前端与 npm 目录，减少无谓重建
RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" \
cargo watch -q -c \
  -w packages/rust \
  -w Cargo.toml \
  -i packages/web \
  -i packages/npm \
  -i packages/web/dist \
  -s "RUSTFLAGS=\"\${RUSTFLAGS:-} -Awarnings\" cargo run -p ${SERVER_BIN} -- --root \"${ROOT}\" --db-path \"${ROOT}/.ailoom/ailoom.db\" --port ${PORT} --no-static 2>&1 | awk '/^AILOOM_PORT=/{ split(\$0,a,\"=\"); printf(\"[dev-all] 前端访问: http://localhost:5173 (API: http://127.0.0.1:%s)\\n\", a[2]); fflush() } { print }'" &
WATCH_PID=$!

# 前端 Dev，指向后端端口
echo "[dev-all] 后端 API: http://127.0.0.1:${PORT} (no static)"
echo "[dev-all] 前端 Dev: http://localhost:5173"
VITE_API_BASE="http://127.0.0.1:${PORT}" pnpm -C "${WEB_DIR}" dev

# 当前端退出，清理后端
cleanup
