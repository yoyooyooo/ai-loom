# ai-loom

A local-first code explorer and annotation service with a Rust (Axum) backend and a React + Vite frontend. It statically serves the UI, exposes a clean `/api/*` surface, persists to SQLite, and ships as a cross‑platform CLI (`npx ai-loom`).

本项目是一个本地优先的代码浏览与批注服务：后端使用 Rust/Axum，前端使用 React + Vite。后端可静态托管前端并提供清晰的 `/api/*` 接口，数据存储于 SQLite；通过跨平台 CLI（`npx ai-loom`）一键运行。

---

## Contents
- 中文说明（Chinese）
- English Guide

---

## 中文说明（Chinese）

### 功能特性
- 后端：Rust/Axum 可执行程序 `ailoom-server`
  - 静态托管前端（默认挂载 `packages/web/dist` 到 `/`）
  - API 路由：`/api/tree`、`/api/file`、`/api/file/full`、`PUT /api/file`、`/api/annotations*`、`/api/stitch`
  - 仅绑定本机 `127.0.0.1`，启动时输出 `AILOOM_PORT=<port>`
- 文件系统：受根目录沙箱保护，支持 `.gitignore` 与可选 `.ailoomignore`，分页读取与二进制探测，原子写与冲突检测
- 前端：React + Vite + Tailwind v4 + shadcn/ui + Monaco（只读/可选编辑）
- 存储：SQLite（WAL、busy_timeout），默认 `~/ailoom/ailoom.db`，失败回退至项目根 `.ailoom/ailoom.db`；按工作区隔离批注可见性
- 分发：`npx ai-loom` 跨平台封装（元包 + 平台二进制子包），安装后开箱即用

### 快速开始
- 一键构建并启动（同源预览：后端托管前端）：
  ```bash
  just serve
  ```
- 仅启动后端（默认托管 `packages/web/dist`）：
  ```bash
  just server-run
  # 或临时覆盖：
  ROOT=. WEB_DIST=packages/web/dist just server-run
  ```
- 开发热更新（前后端联动）：
  - 单终端（Ctrl+C 同时退出）：
    ```bash
    just dev-all PORT=63000
    ```
  - 分终端：
    ```bash
    just server-dev PORT=63000
    just web-dev VITE_API_BASE=http://127.0.0.1:63000
    ```
  - 依赖：`cargo install cargo-watch`
- 仅前端：
  ```bash
  just web-install
  just web-dev VITE_API_BASE=http://127.0.0.1:<port>
  ```
- CLI 启动（无需本地构建）：
  ```bash
  npx ai-loom --root . [--db <path>] [--no-open] [--port <port>]
  ```

### API 便捷调试
```bash
# 目录树
just api-tree PORT=63944 DIR=.
# 文件分页读取
just api-file PORT=63944 FILE=README.md START=1 MAX=2000
```

### 目录结构
- `packages/rust/ailoom-server`：后端 Axum 服务（路由与静态托管）
- `packages/rust/crates/`：领域库
  - `ailoom-core`（类型与错误）
  - `ailoom-fs`（根目录沙箱、忽略规则合并、分页/写入）
  - `ailoom-store`（SQLite 迁移与 CRUD）
  - `ailoom-stitch`（拼接与预算）
- `packages/web`：前端（构建产物位于 `packages/web/dist`）
- `packages/npm`：发布到 npm 的元包与平台二进制子包
- `docs/`：架构、API、数据模型与前端规范（单一事实源 SSoT 位于 `docs/guide/`）
- `templates/`、`.ailoom/`：样例与本地数据（默认 DB `~/ailoom/ailoom.db`，失败回退到项目根）

### 常用命令
- 前端：`just web-install`、`just web-build`、`just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- 后端：`just server-run` 或 `ROOT=. WEB_DIST=packages/web/dist just server-run`
- 热更新：`just server-dev` / `just dev-all` / `just dev`
- 格式化：
  - Rust：`just fmt-rust` / `just fmt-rust-check`
  - Web：`just fmt-web` / `just fmt-web-check`（需先 `just web-install`）
  - 一键：`just fmt` / `just fmt-check`
- 发布/打包：`just publish`（输出 `release/ailoom-<os>-<arch>` 与同名 `.tgz`）

### NPM 包（ai-loom）
- 元包 `ai-loom`：包含 `bin/ai-loom.js` 与 `web/` 静态资源；通过 `optionalDependencies` 指向各平台子包，仅安装与本机匹配的子包
- 子包 `@ai-loom/server-<platform>`：仅包含二进制 `bin/ailoom-server`
- 打包与发布：
  ```bash
  just npm-pack        # 本地打包 .tgz
  just npm-publish     # 发布到 npm（需已登录）
  ```
- 安装与运行：`npx ai-loom` 或 `npm i -g ai-loom && ai-loom`

### 开发约定与规范
- 命名与目录规范：见 `docs/frontend-architecture.md` 与 `docs/specs/explorer-architecture.md`
- React Query 与 API 约定：Query Key 命名以资源名 + 关键参数；写后精准 `invalidate`
- shadcn/ui：必须使用 CLI 安装，目录与别名遵循 `packages/web/components.json`；Tailwind v4 令牌在 `src/styles/globals.css`
- 提交与 PR：建议 Conventional Commits；PR 需包含动机、方案与验证步骤

### 文档（SSoT）
- `docs/guide/architecture.md`（架构与目录）
- `docs/guide/api.md`（API 契约）
- `docs/guide/data-model.md`（数据模型）
- `docs/guide/fs-and-limits.md`（文件系统与阈值）
- `docs/guide/stitching.md`（拼接与预算）
- `docs/guide/frontend.md`（前端结构与流程）
- `docs/guide/annotations-ssot.md`（批注交互）
- `docs/guide/storage.md`（存储层与迁移）
- `docs/guide/security.md`（安全与配置）

### 参与贡献
- 请阅读 `CONTRIBUTING.md` 获取环境、工作流、打包与发布说明

---

## English Guide

### Features
- Backend: Rust/Axum binary `ailoom-server`
  - Serves the frontend statically (mounts `packages/web/dist` at `/` by default)
  - API routes: `/api/tree`, `/api/file`, `/api/file/full`, `PUT /api/file`, `/api/annotations*`, `/api/stitch`
  - Binds to `127.0.0.1` only; prints `AILOOM_PORT=<port>` at startup
- File system: sandboxed to a chosen root; merges `.gitignore` and optional `.ailoomignore`; paginated reads and binary detection; atomic writes with conflict checks
- Frontend: React + Vite + Tailwind v4 + shadcn/ui + Monaco (read‑only / optional editing)
- Storage: SQLite (WAL, busy_timeout). Defaults to `~/ailoom/ailoom.db`, with fallback to project local `.ailoom/ailoom.db`. Annotations are isolated per workspace
- Distribution: Cross‑platform CLI via `npx ai-loom` (meta package + platform binary sub‑packages)

### Quick Start
- One‑command build and serve (same‑origin preview: backend hosts the frontend):
  ```bash
  just serve
  ```
- Backend only (defaults to hosting `packages/web/dist`):
  ```bash
  just server-run
  # or override paths:
  ROOT=. WEB_DIST=packages/web/dist just server-run
  ```
- Hot reload (backend + frontend):
  - Single terminal (Ctrl+C stops both):
    ```bash
    just dev-all PORT=63000
    ```
  - Two terminals:
    ```bash
    just server-dev PORT=63000
    just web-dev VITE_API_BASE=http://127.0.0.1:63000
    ```
  - Requires `cargo install cargo-watch`
- Frontend only:
  ```bash
  just web-install
  just web-dev VITE_API_BASE=http://127.0.0.1:<port>
  ```
- CLI (no local build needed):
  ```bash
  npx ai-loom --root . [--db <path>] [--no-open] [--port <port>]
  ```

### API helpers
```bash
# List tree
just api-tree PORT=63944 DIR=.
# Read file (paged)
just api-file PORT=63944 FILE=README.md START=1 MAX=2000
```

### Repository Structure
- `packages/rust/ailoom-server`: Axum server (routes + static hosting)
- `packages/rust/crates/` domain crates:
  - `ailoom-core` (types and errors)
  - `ailoom-fs` (sandboxed FS, ignore rules, paging/writes)
  - `ailoom-store` (SQLite migrations and CRUD)
  - `ailoom-stitch` (stitching and budgeting)
- `packages/web`: Frontend app (build output in `packages/web/dist`)
- `packages/npm`: npm meta package and platform binary sub‑packages
- `docs/`: architecture/API/data/frontend/storage/security (SSoT under `docs/guide/`)
- `templates/`, `.ailoom/`: examples and local data (default DB at `~/ailoom/ailoom.db` with project fallback)

### Common Tasks
- Frontend: `just web-install`, `just web-build`, `just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- Backend: `just server-run` or `ROOT=. WEB_DIST=packages/web/dist just server-run`
- Hot reload: `just server-dev` / `just dev-all` / `just dev`
- Formatting:
  - Rust: `just fmt-rust` / `just fmt-rust-check`
  - Web: `just fmt-web` / `just fmt-web-check` (requires `just web-install`)
  - All: `just fmt` / `just fmt-check`
- Release/Bundle: `just publish` (outputs `release/ailoom-<os>-<arch>` and `.tgz`)

### npm Packages (ai-loom)
- Meta package `ai-loom`: ships `bin/ai-loom.js` and static `web/`, references platform sub‑packages via `optionalDependencies`
- Sub‑packages `@ai-loom/server-<platform>`: ship only the binary at `bin/ailoom-server`
- Build & publish:
  ```bash
  just npm-pack       # build local .tgz artifacts
  just npm-publish    # publish to npm (requires login)
  ```
- Usage after install: `npx ai-loom` or `npm i -g ai-loom && ai-loom`

### Conventions
- Naming and layout: see `docs/frontend-architecture.md` and `docs/specs/explorer-architecture.md`
- React Query and API: resource‑based query keys; precise invalidations after writes
- shadcn/ui: install via CLI only; follow `packages/web/components.json` aliases; Tailwind v4 tokens defined in `src/styles/globals.css`
- Commits/PRs: prefer Conventional Commits; PRs should include motivation, approach and verification steps

### Documentation (SSoT)
- `docs/guide/architecture.md` (Architecture and layout)
- `docs/guide/api.md` (API contract)
- `docs/guide/data-model.md` (Data model)
- `docs/guide/fs-and-limits.md` (FS and limits)
- `docs/guide/stitching.md` (Stitching and budgeting)
- `docs/guide/frontend.md` (Frontend structure and flow)
- `docs/guide/annotations-ssot.md` (Annotation UX)
- `docs/guide/storage.md` (Storage and migrations)
- `docs/guide/security.md` (Security and configuration)

### Contributing
See `CONTRIBUTING.md` for environment, workflow, packaging and release guidelines.

