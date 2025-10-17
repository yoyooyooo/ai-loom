# Use Bash with strict flags
set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Paths & names
ROOT := "."
WEB_DIR := "packages/web"
WEB_DIST := "packages/web/dist"
SERVER_BIN := "ailoom-server"
DEV_PORT := "63000"

# Default: show help
default:
  @just --list

# --- Web ---

# 安装前端依赖
web-install:
  pnpm -C {{WEB_DIR}} i

# 构建前端产物（输出到 packages/web/dist）
web-build:
  pnpm -C {{WEB_DIR}} build

# 本地开发（可选：设置 VITE_API_BASE 指向后端）
# 用法：just web-dev VITE_API_BASE=http://127.0.0.1:63000
web-dev:
  VITE_API_BASE="${VITE_API_BASE:-}" pnpm -C {{WEB_DIR}} dev

# 清理前端产物
web-clean:
  rm -rf {{WEB_DIST}}

# --- Format ---

# Rust 代码格式化
fmt-rust:
  cargo fmt --all

# Rust 代码格式检查（不修改文件）
fmt-rust-check:
  cargo fmt --all -- --check

# 前端代码格式化（需要先在 packages/web 安装依赖：just web-install）
fmt-web:
  pnpm -C {{WEB_DIR}} exec prettier --write "**/*.{ts,tsx,js,jsx,css,md,html}"

# 前端代码格式检查（不修改文件）
fmt-web-check:
  pnpm -C {{WEB_DIR}} exec prettier --check "**/*.{ts,tsx,js,jsx,css,md,html}"

# 一键格式化（Rust + Web）
fmt:
  just fmt-rust
  just fmt-web

# 一键格式检查（Rust + Web）
fmt-check:
  just fmt-rust-check
  just fmt-web-check

# --- Server ---

# 构建后端（Rust Workspace）
server-build:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}}

# 运行后端，静态托管前端 dist。
# 用法：just server-run ROOT=. WEB_DIST=packages/web/dist
server-run:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo run -p {{SERVER_BIN}} -- --root "${ROOT:-.}" --web-dist "${WEB_DIST:-packages/web/dist}" ${DB_PATH:+--db-path "$DB_PATH"}

# 一键构建前端并启动后端（最常用）
serve:
  just web-build
  just server-run

# 后端热重载（基于 cargo-watch，需要本地安装：`cargo install cargo-watch`）
# 用法：just server-dev [PORT=63000] [ROOT=. WEB_DIST=packages/web/dist]
server-dev PORT='63000':
  if ! cargo watch -V >/dev/null 2>&1; then echo '未检测到 cargo-watch，请先安装：cargo install cargo-watch' && exit 1; fi
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" \
  cargo watch -q -c \
    -w packages/rust \
    -w Cargo.toml \
    -i packages/web \
    -i packages/npm \
    -i packages/web/dist \
    -s "RUSTFLAGS=\"\${RUSTFLAGS:-} -Awarnings\" cargo run -p {{SERVER_BIN}} -- --root \"\${ROOT:-.}\" --web-dist \"\${WEB_DIST:-packages/web/dist}\" --db-path \"\${DB_PATH:-\${ROOT:-.}/.ailoom/ailoom.db}\" --port {{PORT}} 2>&1 | awk '{ print } /^AILOOM_PORT=/{ split(\$0,a,\"=\"); port=a[2]; printf(\"[server-dev] API: http://127.0.0.1:%s\\n\", port); fflush(); }'" 

# 前后端联调热更新（需要另开一个终端）
# 终端A：just server-dev [PORT=63000]
# 终端B：just web-dev VITE_API_BASE=http://127.0.0.1:63000
dev PORT='63000':
  echo "请在另一个终端执行：just web-dev VITE_API_BASE=http://127.0.0.1:{{PORT}}"
  just server-dev PORT={{PORT}}

# 一键前后端联动热更新（单终端运行，Ctrl+C 同时退出前后端）
dev-all PORT='63000':
  bash scripts/dev-all.sh {{PORT}}

# 清理可能的残留（cargo-watch / ailoom-server / 端口占用）
dev-clean PORT='63000':
  bash scripts/cleanup-dev.sh {{PORT}}

# --- 发布 & 打包 ---

# 构建后端 Release 二进制
server-release:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release

# 产出可分发包（包含 Release 二进制与前端构建产物）
# 生成路径：release/ailoom-<os>-<arch> 与同名 .tgz
release-bundle:
  just web-build
  just server-release
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"; \
  OUT_DIR="release/ailoom-${OS}-${ARCH}"; \
  rm -rf "$OUT_DIR"; mkdir -p "$OUT_DIR"; \
  cp "target/release/{{SERVER_BIN}}" "$OUT_DIR/ailoom-server"; \
  mkdir -p "$OUT_DIR/web"; cp -R "{{WEB_DIST}}/"* "$OUT_DIR/web/" 2>/dev/null || true; \
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'DIR="$(cd "$(dirname "$0")" && pwd)"' \
    '# 生产默认使用用户目录 DB，如需项目内 DB，可添加：--db-path "$DIR/.ailoom/ailoom.db"' \
    'exec "$DIR/ailoom-server" --root "$DIR" --web-dist "$DIR/web" ${PORT:+--port $PORT}' \
    > "$OUT_DIR/run.sh"; \
  chmod +x "$OUT_DIR/run.sh"; \
  mkdir -p release; tar -C release -czf "$OUT_DIR.tgz" "$(basename "$OUT_DIR")"; \
  echo "打包完成：$OUT_DIR 和 $OUT_DIR.tgz"

# 一键发布打包（构建 + 压缩包）
publish:
  just release-bundle

# --- NPM 包装与打包 ---

# 准备元包（复制前端 dist 至 packages/npm/ai-loom/web）
npm-meta-prepare:
  just web-build
  rm -rf packages/npm/ai-loom/web
  mkdir -p packages/npm/ai-loom/web
  cp -R {{WEB_DIST}}/* packages/npm/ai-loom/web/ 2>/dev/null || true

# 构建并复制 macOS arm64 二进制到子包
npm-bin-darwin-arm64:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release
  mkdir -p packages/npm/server-darwin-arm64/bin
  cp target/release/{{SERVER_BIN}} packages/npm/server-darwin-arm64/bin/ailoom-server
  chmod +x packages/npm/server-darwin-arm64/bin/ailoom-server

# 构建并复制 macOS x64 二进制到子包（需安装目标 target：rustup target add x86_64-apple-darwin）
npm-bin-darwin-x64:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-apple-darwin
  mkdir -p packages/npm/server-darwin-x64/bin
  cp target/x86_64-apple-darwin/release/{{SERVER_BIN}} packages/npm/server-darwin-x64/bin/ailoom-server || true
  chmod +x packages/npm/server-darwin-x64/bin/ailoom-server || true

# Linux x64 glibc
npm-bin-linux-x64-gnu:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-unknown-linux-gnu
  mkdir -p packages/npm/server-linux-x64-gnu/bin
  cp target/x86_64-unknown-linux-gnu/release/{{SERVER_BIN}} packages/npm/server-linux-x64-gnu/bin/ailoom-server || true
  chmod +x packages/npm/server-linux-x64-gnu/bin/ailoom-server || true

# Linux x64 musl
npm-bin-linux-x64-musl:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-unknown-linux-musl
  mkdir -p packages/npm/server-linux-x64-musl/bin
  cp target/x86_64-unknown-linux-musl/release/{{SERVER_BIN}} packages/npm/server-linux-x64-musl/bin/ailoom-server || true
  chmod +x packages/npm/server-linux-x64-musl/bin/ailoom-server || true

# Linux arm64 glibc
npm-bin-linux-arm64-gnu:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target aarch64-unknown-linux-gnu
  mkdir -p packages/npm/server-linux-arm64-gnu/bin
  cp target/aarch64-unknown-linux-gnu/release/{{SERVER_BIN}} packages/npm/server-linux-arm64-gnu/bin/ailoom-server || true
  chmod +x packages/npm/server-linux-arm64-gnu/bin/ailoom-server || true

# Linux arm64 musl
npm-bin-linux-arm64-musl:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target aarch64-unknown-linux-musl
  mkdir -p packages/npm/server-linux-arm64-musl/bin
  cp target/aarch64-unknown-linux-musl/release/{{SERVER_BIN}} packages/npm/server-linux-arm64-musl/bin/ailoom-server || true
  chmod +x packages/npm/server-linux-arm64-musl/bin/ailoom-server || true

# Windows x64 MSVC（需在 Windows 上运行或配置交叉编译）
npm-bin-win32-x64-msvc:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-pc-windows-msvc
  mkdir -p packages/npm/server-win32-x64-msvc/bin
  cp target/x86_64-pc-windows-msvc/release/{{SERVER_BIN}}.exe packages/npm/server-win32-x64-msvc/bin/ailoom-server.exe || true

# 打包 npm tgz（仅本机平台示例：darwin-arm64 与元包）
npm-pack:
  just npm-meta-prepare
  just npm-bin-darwin-arm64
  pnpm -C packages/npm/server-darwin-arm64 pack
  -pnpm -C packages/npm/server-darwin-x64 pack
  # 可选：如已在对应平台或配置交叉编译，可一并打包其他子包
  -pnpm -C packages/npm/server-linux-x64-gnu pack
  -pnpm -C packages/npm/server-linux-x64-musl pack
  -pnpm -C packages/npm/server-linux-arm64-gnu pack
  -pnpm -C packages/npm/server-linux-arm64-musl pack
  -pnpm -C packages/npm/server-win32-x64-msvc pack
  pnpm -C packages/npm/ai-loom pack

# 发布到 npm（需已登录 npm 并设置权限），按需执行
npm-publish:
  just npm-meta-prepare
  just npm-bin-darwin-arm64
  (cd packages/npm/server-darwin-arm64 && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-darwin-x64 && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  # 如在对应平台或已准备好目标产物，可逐个发布以下子包（发布前请确保 @ai-loom 组织权限就绪）
  - (cd packages/npm/server-linux-x64-gnu && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-x64-musl && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-arm64-gnu && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-arm64-musl && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-win32-x64-msvc && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  (cd packages/npm/ai-loom && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})

# 仅校验（不真正发布到注册表）
npm-publish-dry-run:
  just npm-meta-prepare
  just npm-bin-darwin-arm64
  (cd packages/npm/server-darwin-arm64 && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-darwin-x64 && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-x64-gnu && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-x64-musl && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-arm64-gnu && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-linux-arm64-musl && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  - (cd packages/npm/server-win32-x64-msvc && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  (cd packages/npm/ai-loom && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})

# --- 版本对齐工具 ---

# 对齐 npm 包版本（元包 + 子包）
# 用法：just npm-bump VERSION=0.1.1  或  just npm-bump TYPE=patch
npm-bump VERSION='' TYPE='':
  if [ -n "${VERSION}" ]; then \
    node scripts/bump-npm-version.mjs --version "${VERSION}"; \
  elif [ -n "${TYPE}" ]; then \
    node scripts/bump-npm-version.mjs --type "${TYPE}"; \
  else \
    echo "用法：just npm-bump VERSION=x.y.z | TYPE=patch|minor|major"; exit 1; \
  fi

# 基于最新 Tag 自动 bump（changeset 风格，一键：改版本 -> 提交 -> 打 Tag -> 可选推送）
# 用法：
#   just npm-bump-auto TYPE=patch [PUSH=1] [DRY_RUN=1]
# 说明：
# - 从仓库最后一个形如 vX.Y.Z 的 Tag 读取基线；若不存在则从 0.0.0 开始。
# - 计算新版本，调用 bump 脚本写回 packages/npm/*/package.json 与元包 optionalDependencies。
# - 自动 commit 并创建注释 Tag vX.Y.Z；PUSH=1 时推送当前分支与该 Tag（--follow-tags）。
npm-bump-auto:
  bash scripts/npm-bump-auto.sh

# 一键创建发布分支 + 版本对齐 + 打 Tag（可选推送）
# 用法：
#   just npm-release-start                # 默认 patch，基于 origin/main，新建 release/vX.Y.Z，写版本并打 release-vX.Y.Z
#   TYPE=minor just npm-release-start
#   TYPE=patch PUSH=1 just npm-release-start   # 同时推送分支与 Tag
#   DRY_RUN=1 just npm-release-start           # 仅演练
npm-release-start:
  bash scripts/npm-release-start.sh

# 本地首次发布（当前平台子包 + 元包），一键构建并发布
# 用法：
#   just npm-first-publish-local           # 实发
#   DRY_RUN=1 just npm-first-publish-local # 演练（不写注册表）
#   NPM_OTP=xxxxxx just npm-first-publish-local # 启用 2FA 的一次性验证码
npm-first-publish-local:
  bash scripts/npm-first-publish-local.sh

# --- API 便捷调试 ---

# 需要传入 PORT，例如：just api-tree PORT=63944 DIR=.
api-tree PORT DIR='.':
  curl -s "http://127.0.0.1:{{PORT}}/api/tree" --get --data-urlencode "dir={{DIR}}" | jq .

# 读取文件分页：just api-file PORT=63944 FILE=README.md START=1 MAX=200
api-file PORT FILE START='1' MAX='2000':
  curl -s "http://127.0.0.1:{{PORT}}/api/file" \
    --get --data-urlencode "path={{FILE}}" \
    --data-urlencode "startLine={{START}}" \
    --data-urlencode "maxLines={{MAX}}" | jq .

# 列出批注：just ann-list PORT=63944
ann-list PORT:
  curl -s "http://127.0.0.1:{{PORT}}/api/annotations" | jq .

# 新建批注（简化版）
# 用法：just ann-create PORT=63944 FILE=src/main.rs START=1 END=5 COMMENT='说明' SELECTED='选中文本'
ann-create PORT FILE START END COMMENT SELECTED:
  if [ -z "${PORT:-}" ] || [ -z "${FILE:-}" ] || [ -z "${START:-}" ] || [ -z "${END:-}" ] || [ -z "${COMMENT:-}" ] || [ -z "${SELECTED:-}" ]; then \
    echo "用法：just ann-create PORT=xxxx FILE=相对路径 START=行号 END=行号 COMMENT=说明 SELECTED=选中文本"; exit 1; fi
  jq -nc \
    --arg file "$FILE" \
    --arg start "$START" \
    --arg end "$END" \
    --arg selected "$SELECTED" \
    --arg comment "$COMMENT" \
    '{filePath:$file, startLine:($start|tonumber), endLine:($end|tonumber), selectedText:$selected, comment:$comment, priority:"P1"}' \
    | curl -s -X POST "http://127.0.0.1:{{PORT}}/api/annotations" -H 'content-type: application/json' -d @- | jq .


# --- 工具 ---

# 跨平台打开 URL：just open URL=http://127.0.0.1:xxxx
open URL:
  if command -v open >/dev/null 2>&1; then open "{{URL}}"; \
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "{{URL}}"; \
  elif command -v start >/dev/null 2>&1; then start "{{URL}}"; \
  else echo "{{URL}}"; fi

# 模板目录 templates/vibe-kanban 仅作一次性参考，后续会在完全吸收后删除。
