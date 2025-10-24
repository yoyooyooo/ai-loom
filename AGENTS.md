# Repository Guidelines

## 项目结构与模块组织
- `packages/rust/ailoom-server`：Axum 服务，静态托管前端并提供 `/api/*`。
- `packages/rust/crates/*`：领域库：`ailoom-core`（类型与错误）、`ailoom-fs`（受根目录沙箱的文件读写，支持 `.ailoomignore` 与 `.gitignore`）、`ailoom-store`（SQLite 持久化）。
- `packages/web`：React + Vite 前端，构建产物位于 `packages/web/dist`。
- `docs/`、`templates/`、`.ailoom/`：文档、样例与本地数据（默认 DB `~/ailoom/ailoom.db`，失败回退到项目根 `.ailoom/ailoom.db`）。

## 架构索引（必读）
- 系统架构总览：`docs/guide/architecture.md`（后端/前端/存储/分发，含 WS PUSH+PULL 模型与模块职责）
- WS 通道与自愈：`docs/guide/ws-overview.md`（Ring、events.resume、三路分流、Pump/Supervisor 时序）
- Chat 时间线 SSoT：`docs/guide/codex-chat-turn-ssot.md`（Turn-first 单一事实源；WS 与 resume 事件映射/开始与结束边界/幂等；Compact 特例）
- 按会话 Resume：`docs/specs/004-chat-resume-multisession.md`（`events.resume{ topic, filter.conversationId }`、多会话断点与隔离）
- Codex 协议接入：`docs/specs/codex-protocol-integration.md`（`codex/event/*` → 平台层 `chat.*` 映射与会话元事件）
- 多 Provider 规划：`docs/specs/multi-provider-architecture.md`（长期演进与原地切换）
- Explorer 架构：`docs/specs/explorer-architecture.md`（目录/读取/缓存失效关键路径）

## 核心架构要点（LLM 快读）
- 单事实源（SSoT，聊天）
  - 前端仅信任“平台层 `chat.*` 事件序列”；WS 与 Resume 在后端统一映射为相同的 `chat.*`；前端用同一 reducer 合并为 Turn 序列。
  - 幂等与去重：WS 以 `eventId` 去重；Resume 以顺序 + `turnSeq`（仅 Resume）+ 工具 `callId` 做幂等合并。

- Turn-first（开始/结束边界）
  - 开始优先级：`turn.started|task_started` → `chat.turn.started`；缺失时遇到首条内容事件（`chat.message.delta|reasoning.delta|chat.tool.*`）隐式开启；旧日志再兜底 `user_message`。
  - 结束优先级：`agent_message` → `chat.message.completed` 并结束该轮；失败/中止 → `chat.message.failed|aborted` + 兜底 `chat.turn.complete`；`turn.completed|task_complete` 作为确认型结束（应幂等）。
  - 连续 `agent_message` 代表连续多个 Turn；每条都结束一轮。
  - Compact 特例：文本为 `Compact task completed` 的完成消息，不结束 Turn、不新建 Turn，作为 info 步骤插入当前 Turn（仅标题，无正文）。

- 事件统一映射（精选）
  - 文本/推理：`agent_message(_delta)` → `chat.message.(completed|delta)`；`agent_reasoning(_delta)` → `chat.reasoning.(end|delta)`。
  - 工具：`exec_*` → `chat.tool.exec.(begin|output|end)`；`patch_*` → `chat.tool.patch.(begin|end)`；`mcp_tool_call_*` 或 `response_item(function_call)` → `chat.tool.mcp.(begin|end)`。
  - MCP 名称：优先 `<server>__<tool>`；兼容 `mcp__server__tool`、`mcp:server/tool`、`server/tool`。

- WS 管线（Push + Pull，自愈）
  - Hub：广播与轻量去重；Ring：事件环（提供 `events.resume`）；Forwarder：按 priority/file/tree 三路分发；Writer：单写者（`send+flush`）；Pump：周期从 Ring 拉增量；Supervisor：对比 `hub.lastEventId` 与 `lastSent`，落后则 close-first 促重连+resume。
  - 前端重连：`events.resume({ after, tail=128 })`；按会话过滤：`{ topic: 'chat', filter: { conversationId } }`（多会话隔离）。

- 前端 Store/渲染（Zustand，slice-first）
  - Store 拆分：`<domain>-core.ts`（运行时行为） + `<domain>-snapshot.ts`（纯函数） + `<domain>-snapshot-slice.ts`（actions，复用纯函数） + 薄组合 `<domain>.ts`。
  - Turn 渲染：单 Turn = 用户气泡 + AI 气泡；AI 内聚合步骤（exec/mcp/patch 等）与推理（折叠）；工具展开面板最大高度 200px。
  - 工具步骤索引：以 `callId` 聚合 begin/output/end；Turn 完成后清理索引。

- 开发与约定
  - 默认“读取优先 WS”（写入 REST）；必要时通过 `VITE_WS_NO_FALLBACK=1`/`VITE_WS_WRITE=1` 验证纯 WS；调试 `VITE_WS_DEBUG=1`、`VITE_WS_DEBUG_ROUTE=1`。
  - 前端类型检查：`just web-typecheck`；前端本地开发：`just web-dev`；后端热重载：`just server-dev`；一键联动：`just dev-all`。
  - 命名与结构：文件/目录 `kebab-case`；Store 避免深层 barrel；小型公共工具集中于 `stores/<domain>-utils.ts`，避免跨 slice 重复实现。

## 构建、测试与本地开发
- 一键启动（打包后端静态托管前端）：`just serve`（先构建前端，再运行后端）。
- 开发热更新：
  - 单终端联动：`just dev-all`（同时启动后端热重载 + 前端 Vite Dev，Ctrl+C 一键退出）
  - 分终端：`just server-dev`（后端热重载） + 另起终端 `just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- 仅后端：`just server-run` 或 `ROOT=. WEB_DIST=packages/web/dist just server-run`。
- 前端：`just web-install`、`just web-build`（仅在需要产出静态资源时使用）、`just web-dev VITE_API_BASE=http://127.0.0.1:<port>`。
- 前端类型检查：`just web-typecheck`（调用 `tsc --noEmit`，不生成产物；用于 CI 或本地快速校验 TS 类型）。
- Rust 构建/测试：`cargo build -p ailoom-server`、`cargo test -p <crate>`。
- CLI 启动：`npx ai-loom --root . [--db <path>] [--no-open]`。

### 开发流程约定（重要）
- 使用者会主动执行 `just server-dev` 以启动前后端热更新。Agent 在开发环节不自行启动服务与构建。
- 修改前端后无需执行 `pnpm -C packages/web build`，热更新会自动生效；仅在需要产出静态资源时再使用 `just web-build`/`just serve`。

### WS 开发策略（重要）
- 默认“读取优先 WS”：前端调用通过 `wsPrefer` 优先走 WebSocket，出现传输/能力类错误在短窗内回退 REST；可用 `VITE_WS_NO_FALLBACK=1` 强制纯 WS 验证，`VITE_WS_FUSE_MS` 调整短窗。
- 写入默认 REST；如需验证保存经 WS，可临时开启 `VITE_WS_WRITE=1`（`file.save`）。
- 订阅/推送：由服务端广播 `file.changed`、`tree.changed`、`annotations.*` 驱动缓存失效与 UI 同步；详见 `docs/guide/ws-overview.md` 与 `docs/guide/codex-chat-turn-ssot.md`。
- 调试：`VITE_WS_DEBUG=1` 打开右下角 WS 面板；`VITE_WS_DEBUG_ROUTE=1` 显示每次调用的 WS/REST 路由决策。
- 若后续遇到性能或网络卡点，再按需评估“HTTP 读取 + WS 推送”的混用策略（不作为当前默认）。

## 编码风格与命名
- Rust：遵循 `rustfmt`（4 空格）；类型 `PascalCase`，函数/模块 `snake_case`，常量 `SCREAMING_SNAKE_CASE`。建议本地运行 `cargo fmt && cargo clippy -W warnings`。
- Web（TypeScript/React）：2 空格缩进；组件导出的标识符使用 `PascalCase`；文件与目录一律使用 `kebab-case`（a-b-c），例如：`explorer-page.tsx`、`file-tree-panel.tsx`、`annotation-toolbar.tsx`。已启用 Prettier（见 `packages/web/.prettierrc.json`；约定：单引号、无分号、printWidth=100）。

## 前端架构与目录规范（重要）
- 完整规范参见：`docs/frontend-architecture.md`（强制遵循，含 Zustand slice-first Store 实践与 Provider Store 约定）。
- 与本需求相关的 Explorer 业务侧拆分参见：`docs/specs/explorer-architecture.md`。

## 命名规范（强制）
- 文件与目录使用 `kebab-case`（a-b-c）；其余命名、文件类型与导入顺序请查看 `docs/frontend-architecture.md`。

## 文件类型与导入约定
- `.tsx`：仅在出现 JSX 时使用；否则用 `.ts`。
- 工具/常量/类型文件统一为 `utils.ts`、`constants.ts`、`types.ts`（按需分拆）。
- Store：
  - 结构：推荐 slice-first（`stores/<domain>-core.ts` + `stores/<domain>-snapshot.ts`/slice + 薄组合 `stores/<domain>.ts`）。
  - 导出：`use<Domain>Store`，必要时 `persist({ name: '<app-scope>' })`。
  - 去重约定：通用小工具集中在 `stores/<domain>-utils.ts`，避免在多个 slice 中重复实现（例如 `summarizeFirstLine`、`nowISO`）。
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

## Active Technologies
- TypeScript (Web, React + Vite)、Rust 1.90+（后端 crate） + Web：React、TanStack Query、shadcn/ui；Server：`ailoom-stitch`（内部 crate，被 `ailoom-server` 使用） (001-conditional-omission-note)
- N/A（无数据模型变更） (001-conditional-omission-note)
- Rust 1.90+（后端）、TypeScript（前端，React 18 + Vite） + Codex App Server JSON‑RPC（`codex app-server`）；前端使用 TanStack Query、WS 通道（既有）；shadcn/ui 组件体系 (002-codex-chat-integration)
- 无新增存储；会话持久化由 Codex 侧管理（`~/.codex/sessions/.../rollout-*.jsonl`） (002-codex-chat-integration)
- 无新增存储；会话持久化由 Codex 侧管理（`~/.codex/sessions/.../rollout-*.jsonl`） (002-codex-chat-integration)
- TypeScript 5.x + React 18 (Vite 构建链) + shadcn/ui Sidebar 体系、TanStack Query、Zustand（chat/explorer stores）、Tailwind v4 设计令牌 (005-chat-sidebar-refresh)
- 前端状态由 Zustand/React Query 缓存；会话数据通过现有后端 API 读取（无需新增持久化） (005-chat-sidebar-refresh)

## Recent Changes
- 001-conditional-omission-note: Added TypeScript (Web, React + Vite)、Rust 1.75+（后端 crate） + Web：React、TanStack Query、shadcn/ui；Server：`ailoom-stitch`（内部 crate，被 `ailoom-server` 使用）
