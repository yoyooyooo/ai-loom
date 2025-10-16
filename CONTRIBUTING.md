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

#### 本地首次发布（单命令）
- 一键构建并发布“当前平台子包 + 元包”：
  - 实发：`just npm-first-publish-local`
  - 演练：`DRY_RUN=1 just npm-first-publish-local`
  - 2FA：`NPM_OTP=xxxxxx just npm-first-publish-local`
- 行为：
  - 自动选择本机平台子包（如 `server-darwin-arm64`）并构建二进制
  - 复制前端构建产物到元包 `web/`
  - 先发布子包，再发布元包 `ai-loom`
  - 适用于首次在 npm 上创建包与作用域

### 基于 Tag 的自动发布（推荐）
- 工作流：`.github/workflows/release-npm.yml`（推送 `release-vX.Y.Z` Tag 自动发布 npm）。
- 版本一致性检查：`scripts/check-npm-versions.mjs` 会在 CI 中校验 Tag、元包与所有平台子包版本一致，且 `optionalDependencies` 完整且版本对齐。
- 建议流程：
  1) 从 `main` 拉发布分支（`main` 长期为 `0.0.0`）
  2) 在发布分支上对齐版本：`just npm-bump VERSION=x.y.z` 或 `just npm-bump TYPE=...`
  3) 提交并打 Tag：`git tag -a release-vx.y.z -m "release-vx.y.z" && git push origin release-vx.y.z`
  4) GitHub Actions 自动构建并发布各平台子包，最后发布元包 `ai-loom`
  5) 如组织开启 2FA，请使用具备“自动化发布”权限的 `NPM_TOKEN`（2FA 模式需设为 Authorization-only）

#### Trusted Publishing（免 Token，推荐长期方案）
- 背景：使用 GitHub OIDC 与 npm 的 Trusted Publisher 绑定，无需在仓库保存 `NPM_TOKEN`。
- 配置步骤：
  1) 在 npm（组织或个人作用域）Settings → Packages → Trusted Publishing，添加 GitHub Publisher，选择本仓库与分支/工作流
  2) 确保包的 `repository` 字段指向本仓库（可选但推荐），并已在 npm 上存在对应作用域/包名（首次可本地发布创建）
  3) GitHub Actions workflow 顶层需：
     - `permissions: id-token: write, contents: read`
     - 发布命令使用 `npm publish --provenance --access public`
  4) 不再需要 `NPM_TOKEN`；如仍保留，将回退为 token 模式
  5) 验证：在 Actions 日志中应看到 provenance 签名；npm 包页面显示 provenance 信息

### 版本对齐工具（npm 包）
- 一键对齐元包与所有平台子包版本：
  - 指定版本：`just npm-bump VERSION=0.1.1`
  - 自增规则：`just npm-bump TYPE=patch|minor|major`
- 脚本位置：`scripts/bump-npm-version.mjs`
- 行为：统一更新 `version` 并重建元包的 `optionalDependencies`（把扫描到的 `@ai-loom/server-*` 或 `ai-loom-server-*` 都指向目标版本）。

#### changeset 风格一键 bump + 打 Tag（推荐）
- 命令：
  - 默认 patch：`just npm-bump-auto`
  - 指定级别：`TYPE=minor just npm-bump-auto` 或 `TYPE=major just npm-bump-auto`
  - 推送与演练：`PUSH=1 just npm-bump-auto`、`DRY_RUN=1 just npm-bump-auto`
- 行为：
  - 在执行前默认 `git fetch --tags --prune origin` 同步远端标签（离线失败时继续）
  - 基于最新 `vX.Y.Z` Tag 计算下一个版本（无 Tag 时从 `0.0.0` 起）
  - 调用 bump 脚本写回所有 npm 包版本与 `optionalDependencies`
  - 自动 `git commit` 与创建注释 Tag `vX.Y.Z`；`PUSH=1` 时推送当前分支与 Tag（`--follow-tags`）
  - `DRY_RUN=1` 时仅展示计划操作，不写文件
  - 适用场景：在发布分支执行，以配合 GitHub Actions 的基于 Tag 自动发布

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
