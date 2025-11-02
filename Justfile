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

# 前端类型检查（不生成产物）
web-typecheck:
  pnpm -C {{WEB_DIR}} exec tsc -p tsconfig.json --noEmit

# 前端单元测试（Vitest）
web-test:
  pnpm -C {{WEB_DIR}} test -s

# 前端核心链路测试（WS/Resume→Store，不含 UI 细节）
web-test-core:
  pnpm -C {{WEB_DIR}} exec vitest run --config vitest.core.config.ts

# 前端 UI 冒烟测试（可选，避免过度绑定界面细节）
web-test-ui:
  pnpm -C {{WEB_DIR}} exec vitest run --config vitest.ui.config.ts

# 后端测试（Rust Workspace）
# 用法：just server-test            # 跑整个 workspace
#      just server-test CRATE=ailoom-server  # 仅跑某个 crate
server-test CRATE='':
  if [ -n "${CRATE:-}" ]; then \
    RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo test -p "${CRATE}"; \
  else \
    RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo test --workspace; \
  fi

# 一键测试（后端 + 前端）
test-all:
  just server-test
  just web-test

# 仅核心链路（推荐日常 gating）
test-core:
  just server-test
  just web-test-core

# 仅 UI 冒烟（可选）
test-ui:
  just web-test-ui

# Codex 类型生成（TS + JSON Schema）
codex-codegen TS_DIR='packages/web/src/lib/codex-types' JSON_DIR='docs/specs/codex':
  cargo run -p {{SERVER_BIN}} --bin codegen-codex-types -- --ts-out "{{TS_DIR}}" --json-out "{{JSON_DIR}}"
  if [ -d {{WEB_DIR}}/node_modules ]; then \
    pnpm -C {{WEB_DIR}} exec prettier "src/lib/codex-types/**/*.ts"; \
  else \
    echo "skip prettier (packages/web/node_modules missing)"; \
  fi

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
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo run -p {{SERVER_BIN}} --bin {{SERVER_BIN}} -- --root "${ROOT:-.}" --web-dist "${WEB_DIST:-packages/web/dist}" ${DB_PATH:+--db-path "$DB_PATH"}

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
    -s "RUSTFLAGS=\"\${RUSTFLAGS:-} -Awarnings\" cargo run -p {{SERVER_BIN}} --bin {{SERVER_BIN}} -- --root \"\${ROOT:-.}\" --web-dist \"\${WEB_DIST:-packages/web/dist}\" --db-path \"\${DB_PATH:-\${ROOT:-.}/.ailoom/ailoom.db}\" --port {{PORT}} 2>&1 | awk '{ print } /^AILOOM_PORT=/{ split(\$0,a,\"=\"); port=a[2]; printf(\"[server-dev] API: http://127.0.0.1:%s\\n\", port); fflush(); }'"

# 前后端联调热更新（需要另开一个终端）
# 终端A：just server-dev [PORT=63000]
# 终端B：just web-dev VITE_API_BASE=http://127.0.0.1:63000
dev PORT='63000':
  echo "请在另一个终端执行：just web-dev VITE_API_BASE=http://127.0.0.1:{{PORT}}"
  just server-dev PORT={{PORT}}

# 一键前后端联动热更新（单终端运行，Ctrl+C 同时退出前后端）
dev-all PORT='63000':
  bash scripts/dev-all.sh {{PORT}}

# 调试版：打开更详细的日志、WS 调试
dev-all-debug PORT='63000':
  # 业务调试档：只看握手、gating 与业务事件，不输出底层帧/IO TRACE
  RUST_LOG="${RUST_LOG:-info,ws=debug,ailoom_server=debug,codex=info}" \
  AILOOM_WS_TRACE_CONN="${AILOOM_WS_TRACE_CONN:-1}" \
  # gating 默认关闭（需要时再临时打开），避免噪音
  AILOOM_WS_GATING_DEBUG="${AILOOM_WS_GATING_DEBUG:-0}" \
  # 默认每会话子进程；如需单实例改成 singleton
  AILOOM_CODEX_MODE="${AILOOM_CODEX_MODE:-per_conv}" \
  # 使用与线上一致的超时与行为（不下调 RPC 超时，不自动叠加 ensure）
  AILOOM_CODEX_RPC_TIMEOUT_MS="${AILOOM_CODEX_RPC_TIMEOUT_MS:-}" \
  AILOOM_WS_AUTO_ENSURE_CODEX="${AILOOM_WS_AUTO_ENSURE_CODEX:-0}" \
  # 新连接 watchdog 更保守
  AILOOM_WS_CONN_WATCHDOG_MS="${AILOOM_WS_CONN_WATCHDOG_MS:-1800}" \
  VITE_WS_DEBUG="${VITE_WS_DEBUG:-1}" \
  VITE_WS_DEBUG_ROUTE="${VITE_WS_DEBUG_ROUTE:-1}" \
  bash scripts/dev-all.sh {{PORT}}

# 极限诊断档（仅临时使用）：输出底层帧/IO 等所有 TRACE
dev-all-trace PORT='63000':
  RUST_LOG="${RUST_LOG:-trace,ws=trace,ailoom_server=trace,codex=trace}" \
  AILOOM_WS_TRACE_CONN="${AILOOM_WS_TRACE_CONN:-1}" \
  AILOOM_WS_SUPERVISOR="${AILOOM_WS_SUPERVISOR:-0}" \
  AILOOM_WS_RECOVER_CLOSE_FIRST="${AILOOM_WS_RECOVER_CLOSE_FIRST:-0}" \
  AILOOM_WS_GATING_DEBUG="${AILOOM_WS_GATING_DEBUG:-0}" \
  AILOOM_WS_AUTO_ENSURE_CODEX="${AILOOM_WS_AUTO_ENSURE_CODEX:-0}" \
  AILOOM_WS_CONN_WATCHDOG_MS="${AILOOM_WS_CONN_WATCHDOG_MS:-1800}" \
  VITE_WS_DEBUG="${VITE_WS_DEBUG:-1}" \
  VITE_WS_DEBUG_ROUTE="${VITE_WS_DEBUG_ROUTE:-1}" \
  bash scripts/dev-all.sh {{PORT}}

# 单次前后端联动（不监听；Ctrl+C 同时退出前后端）
dev-all-once PORT='63000':
  bash scripts/dev-all-once.sh {{PORT}}

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
    '# 本地文件监听默认关闭；如需开启：export AILOOM_FSWATCH_ENABLED=1' \
    'export AILOOM_FSWATCH_ENABLED="${AILOOM_FSWATCH_ENABLED:-0}"' \
    '# 默认 WS 单帧写出软超时（更快纠偏）；如需更保守可覆盖为 1500' \
    'export AILOOM_BROADCAST_SEND_TIMEOUT_MS="${AILOOM_BROADCAST_SEND_TIMEOUT_MS:-1000}"' \
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
  # 优先使用 Turbo 构建前端（增量缓存 dist/**）；如不可用则回退到 Vite Build
  # 注意：`turbo -v` 在 2.x 表示 verbose 且无子命令会返回非零，需改用 `--version` 探测
  if pnpm turbo --version >/dev/null 2>&1; then \
    pnpm run -w build; \
  else \
    pnpm -C {{WEB_DIR}} build; \
  fi
  # 强制构建 CLI TypeScript，避免 Turbo 命中后 dist 未更新
  pnpm -C packages/npm/ai-loom build
  rm -rf packages/npm/ai-loom/web
  mkdir -p packages/npm/ai-loom/web
  cp -R {{WEB_DIST}}/* packages/npm/ai-loom/web/ 2>/dev/null || true

## 构建并复制平台二进制到子包
## 用法：
##   just npm-bin TARGET=darwin-arm64|darwin-x64|linux-x64-gnu|linux-x64-musl|linux-arm64-gnu|linux-arm64-musl|win32-x64-msvc
npm-bin TARGET:
  case "${TARGET:-}" in \
    darwin-arm64) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release; \
      mkdir -p packages/npm/server-darwin-arm64/bin; \
      cp target/release/{{SERVER_BIN}} packages/npm/server-darwin-arm64/bin/ailoom-server; \
      chmod +x packages/npm/server-darwin-arm64/bin/ailoom-server \
      ;; \
    darwin-x64) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-apple-darwin; \
      mkdir -p packages/npm/server-darwin-x64/bin; \
      cp target/x86_64-apple-darwin/release/{{SERVER_BIN}} packages/npm/server-darwin-x64/bin/ailoom-server || true; \
      chmod +x packages/npm/server-darwin-x64/bin/ailoom-server || true \
      ;; \
    linux-x64-gnu) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-unknown-linux-gnu; \
      mkdir -p packages/npm/server-linux-x64-gnu/bin; \
      cp target/x86_64-unknown-linux-gnu/release/{{SERVER_BIN}} packages/npm/server-linux-x64-gnu/bin/ailoom-server || true; \
      chmod +x packages/npm/server-linux-x64-gnu/bin/ailoom-server || true \
      ;; \
    linux-x64-musl) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-unknown-linux-musl; \
      mkdir -p packages/npm/server-linux-x64-musl/bin; \
      cp target/x86_64-unknown-linux-musl/release/{{SERVER_BIN}} packages/npm/server-linux-x64-musl/bin/ailoom-server || true; \
      chmod +x packages/npm/server-linux-x64-musl/bin/ailoom-server || true \
      ;; \
    linux-arm64-gnu) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target aarch64-unknown-linux-gnu; \
      mkdir -p packages/npm/server-linux-arm64-gnu/bin; \
      cp target/aarch64-unknown-linux-gnu/release/{{SERVER_BIN}} packages/npm/server-linux-arm64-gnu/bin/ailoom-server || true; \
      chmod +x packages/npm/server-linux-arm64-gnu/bin/ailoom-server || true \
      ;; \
    linux-arm64-musl) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target aarch64-unknown-linux-musl; \
      mkdir -p packages/npm/server-linux-arm64-musl/bin; \
      cp target/aarch64-unknown-linux-musl/release/{{SERVER_BIN}} packages/npm/server-linux-arm64-musl/bin/ailoom-server || true; \
      chmod +x packages/npm/server-linux-arm64-musl/bin/ailoom-server || true \
      ;; \
    win32-x64-msvc) \
      RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}} --release --target x86_64-pc-windows-msvc; \
      mkdir -p packages/npm/server-win32-x64-msvc/bin; \
      cp target/x86_64-pc-windows-msvc/release/{{SERVER_BIN}}.exe packages/npm/server-win32-x64-msvc/bin/ailoom-server.exe || true; \
      chmod +x packages/npm/server-win32-x64-msvc/bin/ailoom-server.exe || true \
      ;; \
    *) \
      echo "未知 TARGET：${TARGET}. 允许值：darwin-arm64|darwin-x64|linux-x64-gnu|linux-x64-musl|linux-arm64-gnu|linux-arm64-musl|win32-x64-msvc"; \
      exit 1 \
      ;; \
  esac

# 打包 npm tgz（仅本机平台示例：darwin-arm64 与元包）
npm-pack:
  just npm-meta-prepare
  just npm-bin TARGET=darwin-arm64
  pnpm -C packages/npm/server-darwin-arm64 pack
  # 可选：如下平台打包需具备对应交叉编译目标
  just npm-bin TARGET=darwin-x64 || true
  -pnpm -C packages/npm/server-darwin-x64 pack
  # 可选：如已在对应平台或配置交叉编译，可一并打包其他子包
  just npm-bin TARGET=linux-x64-gnu || true
  -pnpm -C packages/npm/server-linux-x64-gnu pack
  just npm-bin TARGET=linux-x64-musl || true
  -pnpm -C packages/npm/server-linux-x64-musl pack
  just npm-bin TARGET=linux-arm64-gnu || true
  -pnpm -C packages/npm/server-linux-arm64-gnu pack
  just npm-bin TARGET=linux-arm64-musl || true
  -pnpm -C packages/npm/server-linux-arm64-musl pack
  just npm-bin TARGET=win32-x64-msvc || true
  -pnpm -C packages/npm/server-win32-x64-msvc pack
  pnpm -C packages/npm/ai-loom pack

# 发布到 npm（需已登录 npm 并设置权限），按需执行
npm-publish:
  just npm-meta-prepare
  just npm-bin TARGET=darwin-arm64
  (cd packages/npm/server-darwin-arm64 && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  # 可选平台（需具备交叉编译能力）
  just npm-bin TARGET=darwin-x64 || true
  - (cd packages/npm/server-darwin-x64 && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  # 如在对应平台或已准备好目标产物，可逐个发布以下子包（发布前请确保 @ai-loom 组织权限就绪）
  just npm-bin TARGET=linux-x64-gnu || true
  - (cd packages/npm/server-linux-x64-gnu && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-x64-musl || true
  - (cd packages/npm/server-linux-x64-musl && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-arm64-gnu || true
  - (cd packages/npm/server-linux-arm64-gnu && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-arm64-musl || true
  - (cd packages/npm/server-linux-arm64-musl && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=win32-x64-msvc || true
  - (cd packages/npm/server-win32-x64-msvc && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})
  (cd packages/npm/ai-loom && npm publish --access public ${NPM_OTP:+--otp $NPM_OTP})

# 仅校验（不真正发布到注册表）
npm-publish-dry-run:
  just npm-meta-prepare
  just npm-bin TARGET=darwin-arm64
  (cd packages/npm/server-darwin-arm64 && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=darwin-x64 || true
  - (cd packages/npm/server-darwin-x64 && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-x64-gnu || true
  - (cd packages/npm/server-linux-x64-gnu && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-x64-musl || true
  - (cd packages/npm/server-linux-x64-musl && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-arm64-gnu || true
  - (cd packages/npm/server-linux-arm64-gnu && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=linux-arm64-musl || true
  - (cd packages/npm/server-linux-arm64-musl && npm publish --access public --dry-run ${NPM_OTP:+--otp $NPM_OTP})
  just npm-bin TARGET=win32-x64-msvc || true
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

# --- 调试脚本入口：见 scripts/ 目录（API 便捷调试 / 工具） ---

# 模板目录 templates/vibe-kanban 仅作一次性参考，后续会在完全吸收后删除。
# --- Verify / Smoke ---

# 运行后端与前端测试（WS/REST 等价性 + 前端单测）
verify:
  just verify-rust
  just verify-web
  @echo "[verify] ✅ 后端与前端单测完成"
  @echo "[verify] 下一步（任选）："
  @echo "  - 单终端联动：just dev-all PORT=63000"
  @echo "  - 分终端：just server-dev PORT=63000 与 just web-dev VITE_API_BASE=http://127.0.0.1:63000"
  @echo "  - 开启面板调试：VITE_WS_DEBUG=1"
  @echo "  - Phase 2 验收清单：docs/specs/ws/phase2-acceptance.md"

verify-rust:
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo test -p {{SERVER_BIN}} --tests -- --nocapture

verify-web:
  pnpm -C {{WEB_DIR}} test -s

# 监听风暴压测（需 AILOOM_FSWATCH_ENABLED=1）；COUNT 默认为 1000
burst-listen COUNT='1000':
  bash scripts/fs-burst.sh . {{COUNT}}

# REST 写压测：默认端口 63000、200 次、并发 16
burst-save PORT='63000' COUNT='200' CONC='16':
  AILOOM_PORT={{PORT}} node scripts/save-burst.mjs {{PORT}} {{COUNT}} {{CONC}}
# 强制 WS 模式（仅用于验证 WS 路径；尽量最小开关）
# 默认：开启监听；将 WS 单帧软超时降到 800ms，以便更快触发 close-first + resume
dev-all-ws PORT='63000':
  VITE_USE_WS=1 \
  VITE_WS_NO_FALLBACK=1 \
  VITE_WS_FUSE_MS=0 \
  VITE_WS_WRITE=1 \
  VITE_WS_DEBUG=1 \
  AILOOM_FSWATCH_ENABLED="${AILOOM_FSWATCH_ENABLED:-1}" \
  AILOOM_BROADCAST_SEND_TIMEOUT_MS="${AILOOM_BROADCAST_SEND_TIMEOUT_MS:-800}" \
  RUST_LOG="${RUST_LOG:-ws=info,fswatch=info}" \
  bash scripts/dev-all.sh {{PORT}}

# （已合并至上方 dev-all-debug）


# Phase 3：写路径灰度（读取 WS + 写入优先 WS，允许回退）
dev-ws-write PORT='63000':
  VITE_USE_WS=1 \
  VITE_WS_NO_FALLBACK=0 \
  VITE_WS_FUSE_MS=1500 \
  VITE_WS_DEBUG_ROUTE=1 \
  VITE_WS_WRITE=1 \
  bash scripts/dev-all.sh {{PORT}}
# --- CLI 快速本地测试（使用本仓源码） ---

# 准备 CLI 运行所需资源：构建后端二进制 + 复制前端 dist 到 npm/ai-loom/web
cli-prepare:
  just npm-meta-prepare
  # 确保 dist/cli.js 为最新
  pnpm -C packages/npm/ai-loom build
  RUSTFLAGS="${RUSTFLAGS:-} -Awarnings" cargo build -p {{SERVER_BIN}}

# 直接用 Node 启动 CLI（不经过全局安装），方便本地快速测试
# 用法：just cli [ROOT=. PORT=63000] -- [透传参数，如 --watch]
cli *EXTRA:
  # 仅在需要实际运行时准备产物；可通过 `SKIP_PREPARE=1` 跳过
  if [ "${SKIP_PREPARE:-0}" != "1" ]; then just cli-prepare; fi
  # 判定是否需要监听，并在父进程层注入环境变量（更稳健，等价 dev-all-debug）
  if printf ' %s ' "{{EXTRA}}" | grep -qE '(^|[[:space:]])(--watch|-w)($|[[:space:]])'; then \
    AILOOM_FSWATCH_ENABLED=1 \
      RUST_LOG="${RUST_LOG:-warn,ws=warn,fswatch=warn}" \
      AILOOM_SERVER_BIN="target/debug/{{SERVER_BIN}}" \
      node packages/npm/ai-loom/dist/cli.js --root "{{ROOT}}" --port "${PORT:-63000}" {{EXTRA}}; \
  else \
    RUST_LOG="${RUST_LOG:-warn,ws=warn,fswatch=warn}" \
      AILOOM_SERVER_BIN="target/debug/{{SERVER_BIN}}" \
      node packages/npm/ai-loom/dist/cli.js --root "{{ROOT}}" --port "${PORT:-63000}" {{EXTRA}}; \
  fi

# 仅查看 CLI 帮助，不进行任何构建
cli-help:
  # 若未构建过 CLI，则用 Turbo 构建（仅过滤 ai-loom 包）
  [ -f packages/npm/ai-loom/dist/cli.js ] || pnpm -C packages/npm/ai-loom build >/dev/null 2>&1 || true
  node packages/npm/ai-loom/dist/cli.js --help

# 开启文件监听的 CLI（父进程强制注入监听开关）
# 用法：just cli-watch [ROOT=. PORT=63000] -- [透传参数]
cli-watch *EXTRA:
  if [ "${SKIP_PREPARE:-0}" != "1" ]; then just cli-prepare; fi
  env AILOOM_FSWATCH_ENABLED=1 \
    RUST_LOG="${RUST_LOG:-ws=info,fswatch=info}" \
    AILOOM_SERVER_BIN="target/debug/{{SERVER_BIN}}" \
    node packages/npm/ai-loom/dist/cli.js --root "{{ROOT}}" --port "${PORT:-63000}" ${EXTRA:+ $EXTRA}
