# Repository Guidelines

## 项目结构与模块组织
- `packages/rust/ailoom-server`：Axum 服务，静态托管前端并提供 `/api/*`。
- `packages/rust/crates/*`：领域库：`ailoom-core`（类型与错误）、`ailoom-fs`（受根目录沙箱的文件读写，支持 `.ailoomignore` 与 `.gitignore`）、`ailoom-store`（SQLite 持久化）。
- `packages/web`：React + Vite 前端，构建产物位于 `packages/web/dist`。
- `docs/`、`templates/`、`.ailoom/`：文档、样例与本地数据（默认 DB `~/ailoom/ailoom.db`，失败回退到项目根 `.ailoom/ailoom.db`）。

## 构建、测试与本地开发
- 一键启动（打包后端静态托管前端）：`just serve`（先构建前端，再运行后端）。
- 开发热更新：
  - 单终端联动：`just dev-all`（同时启动后端热重载 + 前端 Vite Dev，Ctrl+C 一键退出）
  - 分终端：`just server-dev`（后端热重载） + 另起终端 `just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- 仅后端：`just server-run` 或 `ROOT=. WEB_DIST=packages/web/dist just server-run`。
- 前端：`just web-install`、`just web-build`（仅在需要产出静态资源时使用）、`just web-dev VITE_API_BASE=http://127.0.0.1:<port>`。
- Rust 构建/测试：`cargo build -p ailoom-server`、`cargo test -p <crate>`。
- CLI 启动：`npx ai-loom --root . [--db <path>] [--no-open]`。

### 开发流程约定（重要）
- 使用者会主动执行 `just server-dev` 以启动前后端热更新。Agent 在开发环节不自行启动服务与构建。
- 修改前端后无需执行 `pnpm -C packages/web build`，热更新会自动生效；仅在需要产出静态资源时再使用 `just web-build`/`just serve`。

## 编码风格与命名
- Rust：遵循 `rustfmt`（4 空格）；类型 `PascalCase`，函数/模块 `snake_case`，常量 `SCREAMING_SNAKE_CASE`。建议本地运行 `cargo fmt && cargo clippy -W warnings`。
- Web（TypeScript/React）：2 空格缩进；组件导出的标识符使用 `PascalCase`；文件与目录一律使用 `kebab-case`（a-b-c），例如：`explorer-page.tsx`、`file-tree-panel.tsx`、`annotation-toolbar.tsx`。已启用 Prettier（见 `packages/web/.prettierrc.json`；约定：单引号、无分号、printWidth=100）。

## 前端架构与目录规范（重要）
- 完整规范参见：`docs/frontend-architecture.md`（强制遵循）。
- 与本需求相关的 Explorer 业务侧拆分参见：`docs/specs/explorer-architecture.md`。

## 命名规范（强制）
- 文件与目录使用 `kebab-case`（a-b-c）；其余命名、文件类型与导入顺序请查看 `docs/frontend-architecture.md`。

## 文件类型与导入约定
- `.tsx`：仅在出现 JSX 时使用；否则用 `.ts`。
- 工具/常量/类型文件统一为 `utils.ts`、`constants.ts`、`types.ts`（按需分拆）。
- Store：`stores/<domain>.ts`，导出 `use<Domain>Store`，必要时 `persist({ name: '<app-scope>' })`。
- Barrel 导出（`index.ts`）：仅允许在 feature 目录边界进行聚合导出；避免深层 barrel 造成循环依赖。
- 路径使用别名 `@` 指向 `src`，避免 `../../../`。
- 导入顺序：第三方 → `@/lib`/`@/stores` → feature 内 → 相对同级/子级。
- 默认导出：优先具名导出；页面/路由组件允许 default 导出。

## React Query 与 API 约定
- Query Key 命名：以资源名 + 关键参数顺序组织，如 `['tree', currentDir]`、`['annotations']`、`['file', path, range]`。
- 缓存策略：对目录树设置 `staleTime/gcTime`，写操作后精确 `invalidateQueries`。
- API 层：`lib/api/client.ts` 只做轻封装与类型绑定；复杂组合逻辑放到 feature 内部 `services/` 或 hooks。

## shadcn/ui 使用规范（强制）
- 任何 shadcn/ui 组件一律使用 CLI 安装，禁止手写或临时拷贝：
  - 初始化：`npx shadcn@canary init -c packages/web`
  - 添加组件：`npx shadcn@canary add <component> -c packages/web`
- 组件目录与别名：遵循 `packages/web/components.json` 配置（`aliases.ui = "@/components/ui"`）。
- Tailwind v4 约定：确保 `vite.config.ts` 已接入 `@tailwindcss/vite`，并在 `src/styles/globals.css` 定义/映射 CSS 变量与 `@theme inline`，以使 `bg-muted`、`text-muted-foreground` 等令牌生效。
- 如需重置配置，请先删除 `packages/web/components.json` 再执行 `init`。

## 测试指南
- Rust：单元测试使用内联 `mod tests`；集成测试放 `tests/`。命名示例：`fs_read_conflict`、`store_import_updates`。
- Web：当前未配置测试；新增复杂逻辑建议配套 Vitest/RTL 基础用例。暂不设覆盖率门槛，但鼓励关键路径最小可回归。

## 提交与 Pull Request
- Commit 约定：历史较少且无固定格式，推荐使用 Conventional Commits（如 `feat: ...`、`fix: ...`、`chore: ...`）。
- PR 要求：包含变更概述、动机与方案、验证步骤（含 `just`/`cargo`/`pnpm` 命令）、必要截图或日志、关联 Issue；保持小而可审。

## 安全与配置提示
- 后端仅绑定本机并回显 `AILOOM_PORT`；文件访问被限制在 `--root`；大文件/二进制自动防护与截断。
- 忽略规则：尊重 `.gitignore` 与可选 `.ailoomignore`。
- 数据库路径：`--db-path`/`--db` 可指定；示例：`ai-loom --root . --db ~/.ailoom/ailoom.db`。
