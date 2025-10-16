#!/usr/bin/env bash
set -euo pipefail

# 一键在本机平台发布：先发布对应平台子包，再发布元包 ai-loom
# 支持：DRY_RUN=1（演练）、NPM_OTP=xxxxxx（如启用 2FA）

DRY_RUN="${DRY_RUN:-0}"

echo "[first-publish] npm whoami / ping"
(npm whoami && npm ping) || {
  echo "尚未登录 npm 或网络异常，请先运行 'npm login'" >&2
  exit 1
}

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
echo "[first-publish] host: ${OS}/${ARCH}"

PKG_DIR=""
BUILD_TASK=""
BIN_NAME="ailoom-server"

case "${OS}-${ARCH}" in
  darwin-arm64)
    PKG_DIR="packages/npm/server-darwin-arm64"; BUILD_TASK="npm-bin-darwin-arm64";
    ;;
  darwin-x86_64|darwin-amd64)
    PKG_DIR="packages/npm/server-darwin-x64"; BUILD_TASK="npm-bin-darwin-x64";
    ;;
  linux-x86_64|linux-amd64)
    # 默认发布 gnu 变体；如需 musl，请在对应 runner/环境再执行
    PKG_DIR="packages/npm/server-linux-x64-gnu"; BUILD_TASK="npm-bin-linux-x64-gnu";
    ;;
  linux-aarch64)
    PKG_DIR="packages/npm/server-linux-arm64-gnu"; BUILD_TASK="npm-bin-linux-arm64-gnu";
    ;;
  msys_nt-10.0-x86_64|mingw*-x86_64|cygwin*-x86_64|windowsnt-10.0-*)
    PKG_DIR="packages/npm/server-win32-x64-msvc"; BUILD_TASK="npm-bin-win32-x64-msvc"; BIN_NAME="ailoom-server.exe";
    ;;
  *)
    echo "暂不支持的本机平台：${OS}/${ARCH}；请在支持的平台上执行" >&2
    exit 1
    ;;
esac

echo "[first-publish] build server binary via: just ${BUILD_TASK}"
just ${BUILD_TASK}

echo "[first-publish] prepare meta web: just npm-meta-prepare"
just npm-meta-prepare

P_FLAGS=(--access public)
if [ "$DRY_RUN" = "1" ]; then P_FLAGS+=(--dry-run); fi
if [ -n "${NPM_OTP:-}" ]; then P_FLAGS+=(--otp "$NPM_OTP"); fi

echo "[first-publish] publish platform subpackage: ${PKG_DIR}"
(cd "$PKG_DIR" && npm publish "${P_FLAGS[@]}")

echo "[first-publish] publish meta package: packages/npm/ai-loom"
(cd packages/npm/ai-loom && npm publish "${P_FLAGS[@]}")

echo "[first-publish] done (dry_run=$DRY_RUN)"

