# Repository Guidelines

## SSoT 与索引（必读）

- `docs/guide/*` 为系统与聊天时间线的 SSoT（单一事实源）规范文档，后续需求开发必须以此为准。
- 如与其他文档、历史实现或注释不一致，以 `docs/guide` 为准；前端/后端/协议事件的边界、映射与幂等语义不得自定义偏离。
- 任何涉及架构或事件流的改动，须先更新对应 `docs/guide/*.md`，并在 PR 中链接所改章节与配套验证步骤。
- 新增功能/任务在评审前需对照 `docs/guide` 逐项自检（开始/结束边界、去重/幂等、WS/Resume 映射、Turn-first 约束）。

- 系统架构总览：`docs/guide/architecture.md`（后端/前端/存储/分发，含 WS PUSH+PULL 模型与模块职责）
- WS 通道与自愈：`docs/guide/ws-overview.md`（Ring、events.resume、三路分流、Pump/Supervisor 时序）
- Chat 时间线 SSoT：`docs/guide/codex-chat-turn-ssot.md`（Turn-first 单一事实源；WS 与 resume 事件映射/开始与结束边界/幂等；Compact 特例）
- Codex Chat WS SSoT：`docs/guide/codex-chat-ws-ssot.md`（Codex 运行时事件 → 平台层 `chat.*`；入环/不入环清单；按会话 resume 与去重）
  - 事件总览：参见文档内“事件分类索引”（会话/消息/推理/工具/信息/回合）与“chat.info.\* 事件清单”。
- per‑conv 运行时与在线状态（通用 Provider）：`docs/specs/012-codex-per-conv-runtime-lifecycle.md`
- 执行器标准层（CLI/API 通用抽象）：`docs/specs/013-executors-standard-layer.md`
- 按会话 Resume：`docs/specs/004-chat-resume-multisession.md`（`events.resume{ topic, filter.conversationId }`、多会话断点与隔离）
- Codex 协议接入：`docs/specs/codex-protocol-integration.md`（`codex/event/*` → 平台层 `chat.*` 映射与会话元事件）
- 多 Provider 规划：`docs/specs/multi-provider-architecture.md`（长期演进与原地切换）
- Explorer 架构：`docs/specs/explorer-architecture.md`（目录/读取/缓存失效关键路径）
- API 概览：`docs/guide/api.md`（WS 方法与 REST 端点提要）

- 维护约定：后续若关键代码/文档路径发生重命名、拆分或合并，必须同步更新本文件（AGENTS.md）的“文件索引/关键词速查”，确保话题→文件最短路径始终有效。

## 核心规则（必背）

- SSoT 与映射：前端仅消费平台层 `chat.*`；服务端将 `codex/event/*` 统一映射为 `chat.*` 并入环。
- 入环/不入环：入环 `chat.message.*`、`chat.reasoning.end`、`chat.tool.*`、`chat.info.*`、`chat.turn.complete`；不入环 `chat.turn.started`、`chat.reasoning.delta|section_break`、`session.stats`、能力/认证类 `codex/*`。
- Resume 语义：`events.resume({ topic:'chat', filter:{ conversationId }, after, tail })`；`after==0` 可用 `tail` 返回近况，`after>0` 忽略 `tail`；被截断返回 `truncated=true` 并触发 `session.resync`。
- 去重与游标：WS 以 `eventId` 去重；Resume 结合顺序/`turnSeq`/`callId`；前端按会话维护 `convLast[cid]` 并持久化。
- Turn-first 边界：首条内容隐式开启；`completed|failed|aborted|turn.complete` 收束；`Compact task completed` 仅作 info 步骤，不结束/新建 Turn。
- 自愈策略：Supervisor 比较 `hub.lastEventId` 与连接 `lastSent`，落后超阈值触发 `session.resync` + 关闭连接，随后重连 + resume。
- RxJS 约定：Observable 统一以 `$` 结尾，Subject 统一以 `$$` 结尾，跨文件引用不得改名；WS 相关 Observable/Subject 必须统一在 `packages/web/src/lib/ws/runtime-subjects.ts` 定义与导出；禁止在业务模块顶层随意 `new Subject()`。
 - RxJS 编排：少量必要的模块顶层 Observable/Subject 即可；业务逻辑优先在管道内闭合，使用 `scan`、`withLatestFrom` 等操作符折叠状态或派生数据，减少外部变量与手写订阅，保持函数式、可读、易拆分；跨模块暴露一律通过 `packages/web/src/lib/ws/runtime-subjects.ts` 统一出口。

## 文件索引（话题→文件）

- 聊天时间线与边界（Turn-first/幂等）
  - 规范：`docs/guide/codex-chat-turn-ssot.md`
  - 前端：`packages/web/src/features/codex-chat/stores/chat-turns-snapshot.ts`、`.../services/processors/*`
- 信息/元提示事件（chat.info.\*）
  - 规范：`docs/guide/codex-chat-ws-ssot.md`（“chat.info.\* 事件清单”小节）
- 按会话 Resume（WS 增量补偿）
  - 规范：`docs/guide/codex-chat-ws-ssot.md`
  - 服务端：`ws/methods.rs::events.resume`、`ws/hub.rs::{resume_after_chat,tail_chat}`
  - 前端：`lib/ws/rx-client.ts::resumeChat`
- WS Ring/广播/自愈（PUSH+PULL）
  - 规范：`docs/guide/ws-overview.md`
  - 服务端：`ws/hub.rs::{broadcast,broadcast_ephemeral,stats_snapshot}`、`ws/conn.rs`（Forwarder/Writer/Pump/Supervisor）
- Codex 接入与映射（codex/event/_ → chat._）
  - 服务端：`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs::{map_notification_to_chat_events,provider_payload}`、`.../client.rs`
- 多 Provider 执行器（统一抽象）
  - 规范：`docs/specs/013-executors-standard-layer.md`
  - 服务端（规划）：`services/executors/{registry.rs,providers/*}`（provider 无关运行时与桥接）
- 工具执行/输出/聚合（exec/patch/mcp）
  - 服务端映射：`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs` 中 `exec_*`/`patch_*`/`mcp_tool_call_*`
- 前端聚合：`features/codex-chat/services/processors/*`、`stores/chat-turns*.ts`
- 文件保存与监听
  - 服务端：`ws/methods.rs::file.save`、`ws/watch.rs`（fswatch 合批）
  - 前端无效器：`features/explorer/ws-invalidators/*`
- 历史回放与快照注入
  - 服务端：`routes/chat/resume/*`
  - 前端：`features/codex-chat/stores/chat-turns-snapshot.ts`、`stores/chat-resume.ts`
- 能力/认证/额度（codex/\*）
  - 服务端：`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs::{map_server_notification,map_generic_notification}`
  - 前端：`features/codex-chat/services/ws-capabilities.ts`
- 调试面板（WS 观测）
  - 前端：`lib/ws/ws-debug-panel.tsx`
 - WS 运行时 Subjects 汇总
   - 前端：`packages/web/src/lib/ws/runtime-subjects.ts`
  
- Store 组合与类型（Slice-first + StoreCreator）
  - 规范：`docs/frontend-architecture.md`（3.4 小节）
  - 示例：`packages/web/src/features/codex-chat/stores/chat-turns.types.ts`（`ChatTurnStoreCreator<TSlice>`）

## 关键词速查（代码定位）

- `events.resume`、`resume_after_chat`、`tail_chat`
- `broadcast`、`broadcast_ephemeral`、`EventRecord`、`stats_snapshot`
- `conversationId`、`convLast`、`lastEventId`、`session.resync`
- `map_notification_to_chat_events`、`codex/event/`、`chat.tool.exec|patch|mcp`
- `chat.message.completed|delta|failed|aborted`、`chat.reasoning.end|delta`、`chat.turn.complete`
- `chat.info.runtime.child_up|chat.info.runtime.child_down`、`session.runtime`
- `packages/web/src/lib/ws/runtime-subjects.ts`
- `/api/chat/runtime`、`POST .../warm`、`DELETE .../process`
- 查询参数：`provider=<codex|...>`（省略时默认 `codex`）
- `AILOOM_EXEC_IDLE_MS|AILOOM_EXEC_GC_INTERVAL_MS|AILOOM_EXEC_MAX_CHILDREN|AILOOM_EXEC_USE_PROC_GROUP`

搜索示例（ripgrep）：

- `rg -n "events\.resume|resume_after_chat|tail_chat" packages/rust/ailoom-server -S`
- `rg -n "map_notification_to_chat_events|codex/event" packages/rust/ailoom-server -S`
- `rg -n "convLast|resumeChat\(|lastEventId" packages/web -S`

## 开发与运行

- 一键联动：`just dev-all`（后端热重载 + 前端 Vite Dev）
- 仅后端：`just server-dev` / 运行：`just server-run`
- 仅前端：`just web-dev [VITE_API_BASE=...]`；类型检查（完成大模块/大改动后执行）：`just web-typecheck`
- 大改造或单个模块需求完成后：执行 `lfiles -m 800` 排查 800 行以上文件；800+ 必须尽快评估拆分，1000+ 视作紧急拆分任务。
- 大模块完成后统一格式化：`just fmt`（Rust + Web 一键格式化）
- 测试：`just test-all`（或 `just server-test` / `just web-test`）
- Ring、去重与调试：`VITE_WS_DEBUG=1` 打开面板；`AILOOM_WS_RING_CAP` 调整事件环；`AILOOM_WS_DEDUP_MS` 调整 file.changed 去重窗口。
- 开发端口：后端在开发环境固定 `63000`；可用 curl 自测：
  - `curl -s http://127.0.0.1:63000/api/tree?dir=.`
  - `curl -s http://127.0.0.1:63000/api/chat/config`

## 环境变量速查

- 前端：`VITE_WS_DEBUG`（调试面板）、`VITE_WS_DEBUG_ROUTE`（路由决策）、`VITE_WS_NO_FALLBACK`（禁用 REST 回退）、`VITE_WS_WRITE`（保存走 WS）、`VITE_WS_RESUME`（启动时尝试通用 resume）
- 后端：`AILOOM_WS_RING_CAP`（默认 1024）、`AILOOM_WS_DEDUP_MS`（file.changed 去重窗口，默认 200ms）、`AILOOM_FSWATCH_ENABLED`（启用 FS Watcher）、`AILOOM_WS_EAGER_SAVE_ECHO`（保存后额外瞬时 echo）

## 代码风格与约定

- 命名与结构：目录/文件 `kebab-case`；前端路径别名 `@` 指向 `src`；避免深层 barrel；公共小工具集中在 `stores/<domain>-utils.ts`。
- 前端：Zustand slice-first；React Query 负责查询类接口与快照，流式由 RxJS；API 轻封装在 `lib/api/client.ts`。
- 前端 Store：统一采用“Slice-first + StoreCreator 复用”模式（强制）。
  - 在 store 层声明 `StoreCreator<TSlice>`（基于 `StateCreator`），一次性约束本 store 的中间件（如 `immer`、`subscribeWithSelector`/`devtools`）。
  - 各切片 `createXxxSlice: StoreCreator<Slice>` 复用该类型；入口用 `create<FinalStore>()(middlewares(...))` 合并切片。
  - 详见：`docs/frontend-architecture.md` 的“3.4 Slice × 类型模式（StoreCreator 复用）”。
- UI：shadcn/ui 一律用 CLI 安装（`npx shadcn@canary ... -c packages/web`），Tailwind v4 已接入 `@tailwindcss/vite`。
- 格式化：Rust 遵循 rustfmt；Web 启用 Prettier（单引号、无分号、printWidth=100）。

## 提交流程与测试

- Commit：推荐 Conventional Commits（`feat:`/`fix:`/`chore:`）。
- PR：提供变更概述/动机/验证步骤（含 `just`/`cargo`/`pnpm` 输出摘要）与必要截图；保持小而可审。
- 最小验证：`just test-all` 必须通过；仅改特定 crate 时可用 `just server-test CRATE=...`。

## 安全与配置

- 绑定与回显：仅绑定本机，启动回显 `AILOOM_PORT`。
- 文件沙箱：访问受 `--root` 限制；尊重 `.gitignore`/`.ailoomignore`；大文件/二进制自动防护与截断。
- 数据库：默认 `~/.ailoom/ailoom.db`，失败回退项目根 `.ailoom/ailoom.db`；可用 `--db-path/--db` 指定。

## 延伸规范（索引）

- 前端整体：`docs/frontend-architecture.md`
- Explorer 业务：`docs/specs/explorer-architecture.md`
- 聊天存储（SSoT 镜像与投影）：`docs/specs/011-chat-storage-ssot-events-mirror-and-projection.md`

## 参考仓库（本机路径）

- Codex 源码（协议/事件来源）：`/Users/yoyo/Documents/code/community/codex`
- 参考实现（后端结构/WS 细节，我们和它用了一样的 codex app-server，必要时查阅其源码）：`/Users/yoyo/Documents/code/community/vibe-kanban`
