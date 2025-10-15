# 贡献指南（开发者）

本仓库包含 Rust 后端（Axum）与 Web 前端（React + Vite），以及用于发布的 npm 包装（元包 + 平台二进制子包）。本文面向参与开发与发布的贡献者。

## 环境要求
- Rust stable（建议安装 rustup）
- Node.js 18+、pnpm 8+/9+
- just（可选，推荐）
- cargo-watch（后端热重载）：`cargo install cargo-watch`

## 仓库结构
- 后端：`packages/rust/ailoom-server`（Axum，静态托管前端并提供 `/api/*`）
- 领域库：`packages/rust/crates/*`（`ailoom-core/fs/store/stitch`）
- 前端：`packages/web`（React + Vite，构建产物在 `packages/web/dist`）
- npm 元包（对外发布）：`packages/npm/ai-loom`（`bin/ai-loom.js` + `web/`）
- npm 平台二进制子包：示例 `packages/npm/server-darwin-arm64`（包名：`@ai-loom/server-darwin-arm64`）

## 快速开始（本地开发）
- 安装前端依赖：`just web-install`
- 一键同源预览（构建前端后由后端托管）：`just serve`
- 前后端热更新联调：
  - 终端A（后端热重载 + 项目内 DB）：`just server-dev PORT=63000`
  - 终端B（前端 dev 指向后端）：`just web-dev VITE_API_BASE=http://127.0.0.1:63000`
  - 或 `just dev`（当前终端启动后端热重载，并提示另一终端的前端命令）

说明：
- CORS：后端已对 `/api/*` 启用宽松 CORS，便于 Vite 跨源联调。
- 端口：后端支持 `--port`，开发推荐固定端口（默认 63000）。
- DB 路径：
  - 开发（`server-dev`）：固定使用项目内 `--db-path "<ROOT>/.ailoom/ailoom.db"`
  - 生产/同源：默认 `~/ailoom/ailoom.db`，失败回退到项目内 `.ailoom/ailoom.db`

## 常用 just 任务
- `just web-install` / `just web-build` / `just web-dev VITE_API_BASE=...`
- `just server-build` / `just server-run [ROOT . WEB_DIST=packages/web/dist]`
- `just server-dev [PORT=63000]` / `just dev`
- 代码格式化：`just fmt`（一键 Rust + Web）/ `just fmt:check`，或分别使用 `just fmt-rust` / `just fmt-web`
- API 调试：`just api-tree PORT=xxxx DIR=.`, `just api-file PORT=xxxx FILE=README.md START=1 MAX=2000`
- 打包（Release 二进制 + 前端）：`just publish`（输出 `release/ailoom-<os>-<arch>`）

## 编码规范
- Rust：`rustfmt`（4 空格）；类型 `PascalCase`，函数/模块 `snake_case`，常量 `SCREAMING_SNAKE_CASE`。
  - 开发建议：`cargo fmt && cargo clippy -W warnings`
- Web（TypeScript/React）：2 空格缩进；组件 `PascalCase`；模块/文件小写短名（如 `app.tsx`）。已启用 Prettier（单引号、无分号、printWidth=100），运行 `just fmt-web`。
- shadcn/ui（强制）：
  - 初始化：`npx shadcn@canary init -c packages/web`
  - 添加组件：`npx shadcn@canary add <component> -c packages/web`
  - 目录与别名遵循 `packages/web/components.json`（`aliases.ui = "@/components/ui"`）
  - Tailwind v4：`vite.config.ts` 接入 `@tailwindcss/vite`，并在 `src/styles/globals.css` 定义 CSS 变量与 `@theme inline`

## 测试建议
- Rust：单元测试内联 `mod tests`；集成测试位于 `tests/`。
- Web：目前未强制；如新增复杂逻辑建议配套 Vitest/RTL 最小用例。

## 提交与 PR
- Commit 建议 Conventional Commits：`feat:` / `fix:` / `chore:` / `docs:` / `refactor:` …
- PR 请包含：变更概述、动机与方案、验证步骤（`just`/`cargo`/`pnpm` 命令）、必要截图或日志、关联 Issue；保持小而可审。

## NPM 发布（ai-loom）
发布形态采用「元包 + 平台二进制子包」：
- 元包 `ai-loom`：包含 `bin/ai-loom.js` 与前端静态资源 `web/`；通过 `optionalDependencies` 指向各平台子包；安装时仅拉取与本机匹配的子包。
- 子包 `@ai-loom/server-<platform>`：仅包含预编译二进制 `bin/ailoom-server`，并在 `package.json` 中声明 `os`/`cpu`（Linux 可加 `libc`）。

发布准备：
- 登录 npm：`pnpm login` 或 `npm login`
- 如组织使用 2FA：发布时通过 `NPM_OTP=xxxxxx` 注入一次性验证码
- 版本对齐：统一 bump `packages/npm/ai-loom` 与各子包版本，并同步更新元包的 `optionalDependencies` 版本

命令：
- 预检查（dry-run）：`just npm-publish-dry-run`
- 正式发布：`just npm-publish`（或 `NPM_OTP=xxxxxx just npm-publish`）

### 版本对齐工具（npm 包）
- 一键对齐元包与所有平台子包版本：
  - 指定版本：`just npm-bump VERSION=0.1.1`
  - 自增规则：`just npm-bump TYPE=patch|minor|major`
- 脚本位置：`scripts/bump-npm-version.mjs`
- 行为：统一更新 `version` 并重建元包的 `optionalDependencies`（把扫描到的 `@ai-loom/server-*` 或 `ai-loom-server-*` 都指向目标版本）。

注意：
- 404 Scope not found：`@ai-loom` 需在 npm 上创建组织并授予发布权限；或临时改为无 scope 包（例如 `ai-loom-server-darwin-arm64`），并同步更新元包 `optionalDependencies` 与二进制选择逻辑。
- EACCES 二进制不可执行：子包已在 `postinstall` 执行 `chmod +x ./bin/ailoom-server`。
- 安装后使用：`npx ai-loom` 或 `npm i -g ai-loom && ai-loom`；支持透传 `--port`、`--db-path` 等后端参数。

## 多平台支持（扩展）
已提供以下子包（可按需在对应平台或交叉编译环境构建）：
- `@ai-loom/server-darwin-arm64` / `@ai-loom/server-darwin-x64`
- `@ai-loom/server-linux-x64-gnu` / `@ai-loom/server-linux-x64-musl`
- `@ai-loom/server-linux-arm64-gnu` / `@ai-loom/server-linux-arm64-musl`
- `@ai-loom/server-win32-x64-msvc`
实现步骤：
1) 新增子包目录与 `package.json`（配置 `os`/`cpu`/`libc`）
2) `just` 中仿照 `npm-bin-darwin-arm64` 添加拷贝二进制任务
   - 已内置：`npm-bin-darwin-x64`、`npm-bin-linux-x64-gnu`、`npm-bin-linux-x64-musl`、`npm-bin-linux-arm64-gnu`、`npm-bin-linux-arm64-musl`、`npm-bin-win32-x64-msvc`
3) 元包 `optionalDependencies` 增加新子包；`bin/ai-loom.js` 的平台映射（已引入 `detect-libc`）
4) 本地 `just npm-pack` 验证；CI 可用矩阵分别构建并 `npm publish`

## 故障排查
- just 语法错误（如 found '{'）：参数默认值需写为字面量，如 `server-dev PORT='63000':`
- 跨源无法访问：确认前端 dev 传入 `VITE_API_BASE=http://127.0.0.1:<port>`；后端已对 `/api/*` 启用 CORS
- 端口被占用：更换 `PORT` 或传 `--port` 启动
- npm 404（Scope not found）：参考上文“注意”
- Linux glibc/musl：使用 `detect-libc` 区分，元包仅安装匹配的子包

## 文件参考（关键入口）
- 后端端口/CORS：`packages/rust/ailoom-server/src/main.rs:24`, `packages/rust/ailoom-server/src/main.rs:71`, `packages/rust/ailoom-server/src/main.rs:83`
- 热更新与发布脚本：`Justfile:50`, `Justfile:96`, `Justfile:112`
- 元包入口（npm）：`packages/npm/ai-loom/bin/ai-loom.js:1`
- 子包清单（示例）：`packages/npm/server-darwin-arm64/package.json:1`

欢迎通过 PR/Issue 进行改进与反馈！
