# Per-conv 运行时生命周期与在线状态（通用 Provider，提案）

本文定义在“每会话独立运行时（per-conv）”模式下，Provider 无关的生命周期管理、在线状态可观测、WS/REST 接口、资源回收与优雅停机。适用于两类 Provider：
- 执行器型（CLI/子进程）：如 Codex app-server、Claude Code CLI、Gemini CLI 等；
- API 型（HTTP 流）：如 OpenAI/Anthropic/Gemini 的流式 LLM API（通过平台侧“虚拟运行时”承载）。

本文为设计细化与实施说明，SSoT 仍以 `docs/guide/*` 为准；涉及事件入环的部分已按 SSoT 约束标注。

## 1. 目标与范围

- 目标
  - 仅保留 per-conv：每个会话独占一个运行时（子进程或虚拟任务）；同一会话的后续消息、工具与中断都复用该运行时。
  - turn 完成后支持快速 follow‑up，但会话闲置一段时间后自动释放以节省资源。
  - 前端可以直观看到“该会话是否在线/正在启动/空闲/繁忙/已释放”。
  - 主进程退出或异常时，可靠终止所有子进程（含子树）；API 型运行时可被可靠取消与收敛。

- 范围
  - 后端 Registry（会话→运行时句柄）逻辑与并发安全约束；
  - 在线状态事件与 REST/WS 接口；
  - 资源回收、进程组与优雅停机；
  - 与 SSoT 的入环/不入环边界；
  - 测试与运维观测。

## 2. 模式与对比

- per_conv（本方案，唯一支持）：每会话一个运行时（CLI 进程或 API 虚拟任务），turn 间复用，闲置自动回收，支持 interrupt 与状态观测。
- per_request：每轮新起进程/请求，跑完即退，无会话级复用（不支持）。
- singleton：单实例复用所有会话（不支持）。

## 3. 生命周期（后端）

- 新建会话：`spawn_new(provider, workspace, params)`
  - 执行器型：拉起 Provider 子进程 → 完成初始化/握手（例如 Codex 的 `initialize`/`newConversation`/`addConversationListener`）→ 写入 Registry。
  - API 型：分配“虚拟运行时”（建立流式任务与取消句柄）→ 写入 Registry。
  - 记录 `created_ms`/`last_used_ms`，广播 `chat.session.new`（既有）与上线事件（见 §5）。

- 发送消息：`send_user_message(provider, cid, text)`
  - 快路径：Registry 命中句柄 → 确保监听 → 直接发送（CLI：JSON‑RPC；API：HTTP 流请求）→ 刷新 `last_used_ms`。
  - 慢路径：未命中/运行时退出 → `resume_conversation(rollout)` → 监听 → 发送 → 写回 Registry。
  - 并发安全：严禁“持锁跨 await”。统一模式：取锁克隆句柄→释放锁→await→回写。

- 仅监听：`ensure_listener(provider, cid)`
  - 同上，优先复用；未命中则 `resume_conversation`。

- 中断：`interrupt_conversation(provider, cid)`
  - 复用句柄直接发 `interrupt`（CLI：JSON‑RPC；API：取消流/请求）；无句柄则 `ensure_listener` 后再发。

- 回收：`init_gc()` 循环 + `gc_if_needed()`
  - 环境变量：`AILOOM_EXEC_IDLE_MS`（默认 60000ms）、`AILOOM_EXEC_GC_INTERVAL_MS`（默认 5000ms）、`AILOOM_EXEC_MAX_CHILDREN`（默认 6）。
  - 策略：按 `idle_ms` 选择回收，优先回收超阈值者；资源饱和时可选“硬上限回收最久未使用且非 busy 的会话”。
- 调度总线：`RuntimeRegistry`（`services/executors/registry.rs`）统一封装上述操作，并通过 `AppState.runtime_registry` 对路由/WS 暴露；任何新 Provider 只需在 `services/executors/providers/*` 实现 `StandardProvider` 并在启动阶段注册。

## 4. 在线状态机

- 状态枚举（后端维护）：`starting` | `running` | `busy` | `idle` | `terminating` | `offline`。
  - `starting`：`spawn_new` 成功且 Provider 尚未 ready（示例：Codex 未收到 `codex/sessionConfigured`）。
  - `running`：Provider 已 ready，且当前不在任务中（`busy=false`）。
  - `busy`：收到 `codex/event/task_started` 至 `task_completed`（或 `item_*` 完成）期间。
  - `idle`：`running` 且超过 0s 无活动（UI 可直接把 `running` 视为在线绿点，`idle` 用于统计）。
  - `terminating`：显式 `hard_kill` 或 GC 选中回收时进入；
  - `offline`：子进程真实退出或回收完成。

- 计时基准
  - 刷新 `last_used_ms` 的时机：`spawn_new` 成功、每次 `send_user_message` 成功、`ensure_listener` 命中复用、`interrupt_conversation`、`resume_conversation` 成功；
  - 可选：在映射 `chat.turn.complete` / `chat.reasoning.end` 时额外刷新一次，使“turn 完成 → idle 计时”语义更直观。

## 5. 事件与接口（统一 Provider）

入环（ring）事件（SSoT 允许的 info 类）：
- `chat.info.runtime.child_up`：运行时（子进程或虚拟任务）上线（含 `provider`、`conversationId`、`pid?`、`ts`、`reason`）。
- `chat.info.runtime.child_down`：运行时下线（显式 kill/GC/异常退出/取消，含 `provider`、`reason`）。
  - `reason` 约定：`spawn`（新建）、`resume`（rollout 恢复）、`ensure`（被动预热）、`process_gone`（检测到子进程消失并重建）、`idle_timeout`（闲置回收）、`idle_gc`（超限回收）、`hard_kill`（显式释放）。

不入环（瞬时观测）：
- `session.runtime`（或复用 `session.stats` 扩展字段）：周期广播所有会话的 `{ provider, conversationId, status, idleMs, pid?, generating, ts }`，仅用于调试/状态面板与生成态聚合。

REST：
- `GET /api/chat/runtime?provider=<all|codex|claude|...>`：返回 `[{ provider, conversationId, status, idleMs, pid?, generating }]`（聚合 Registry + 状态机），默认 `provider=codex`（`provider=all` 返回已注册 Provider 的合并快照）。
- `POST /api/chat/conversations/:id/warm?provider=...`：预热指定会话（ensure/resume + 监听）。
- `DELETE /api/chat/conversations/:id/process?provider=...`：释放指定会话运行时（映射 `hard_kill`/取消）。

WS：
- 保持既有 `chat.session.new`、`chat.session.sync_begin/end`、`chat.info.user_message` 等；
- 新增上线/下线 `chat.info.runtime.child_up|down` 入环，瞬时快照走 `session.runtime`（不入环），并补充 `chat.info.runtime.generating`（入环）用于显式标记“该会话当前是否在生成响应”。

SSoT 约束：
- 入环只包含上线/下线等“边界”事件，resume 时可回放；瞬时状态用 `broadcast_ephemeral`，不携带 `eventId`，不污染去重/游标。

## 6. 运行时与优雅停机

- 执行器型（CLI）：
  - 进程组：Unix 平台默认启用 `command_group::AsyncCommandGroup::group_spawn()`，确保主进程结束能级联终止子树；Windows 回退 Job 对象/`spawn()`（按平台评估）。
  - kill-on-drop：启用 `kill_on_drop(true)`；
  - 自然退出监测：定期 `try_wait()`，发现已退出则标记 `offline` 并广播 `child_down`（reason=exited）。
- API 型（HTTP）：
  - 取消：保存取消句柄（Abort/CancelToken），在优雅停机与回收时触发取消；
  - 自然结束：流完成时标记 `offline` 并广播 `child_down`（reason=completed）。
- 优雅停机：Axum `with_graceful_shutdown` 捕获 SIGINT/SIGTERM → 遍历 Registry 执行 `terminate()`/取消 → 广播 `child_down` → 退出。

## 7. 并发与质量保障

- 严禁“持锁跨 await”：`REGISTRY` 操作一律采用“取锁克隆→释放锁→await→回写”的模板；
- CI 强制 `cargo clippy -- -W clippy::await-holding-lock`；
- 可以将 Registry 内部 `HashMap+Mutex` 逐步替换为 `DashMap` 或 `RwLock<HashMap>` 以缩短写锁占用；
- 提供 `registry.snapshot()` 与 `/api/chat/runtime` 便于观测与调试。

## 8. 配置项（环境变量）

- `AILOOM_EXEC_IDLE_MS`：闲置阈值，默认 `60000`。
- `AILOOM_EXEC_GC_INTERVAL_MS`：GC 周期，默认 `5000`。
- `AILOOM_EXEC_MAX_CHILDREN`：最大并行运行时数，默认 `6`。
- `AILOOM_EXEC_USE_PROC_GROUP`：是否启用进程组（默认 `1` on Unix，CLI 型有效）。
- `AILOOM_EXEC_RPC_TIMEOUT_MS`：请求超时（例如 Codex JSON‑RPC），默认 `30000`。

## 9. 前端联动（建议）

- UI 小绿点/灰点显示会话在线状态；
- 生成状态拆分：全局 `Generating` 指示器仅追踪 `generating=true` 的会话列表（使用 `chat.info.runtime.generating` + `/api/chat/runtime` 初始种子）；后台预热但未生成的会话不占用指示器。
- 状态文案区分：启动中（starting）、运行中（running/busy）、空闲（idle）、释放中（terminating）、已离线（offline）；
- 入口：预热按钮（warm）、结束会话（hard kill）；
- 调试面板显示 `/api/chat/runtime` 快照（或订阅 `session.runtime`）。

## 10. 测试与验证

- 单测（不依赖 Codex）：模拟 Registry 快/慢路径、连续两次 send（fast‑path）→ interrupt → hard_kill，不得阻塞；
- 集成（CLI 与 API）：两轮会话流转，验证上线/下线事件、idle 回收、预热、显式释放/取消、优雅停机；
- 退出测试：向主进程发 SIGTERM，确认无残留 `node` 进程（进程组生效）。

## 11. 实施清单（摘要）

- 后端
  - Registry（provider 无关）：全路径完成“取锁→释放→await→回写”改造；
  - 新增状态机，按 Provider 事件映射 `starting/running/busy/…`；
  - 新 REST：`GET /api/chat/runtime`、`POST warm`、`DELETE process`（均含 `provider`）；
  - 新 WS：`chat.info.runtime.child_up|down`（入环），`session.runtime`（瞬时）；
  - CLI：进程组启动；API：取消句柄；优雅停机钩子；
  - 在 `chat.turn.complete` 处刷新 `last_used_ms`（可选）。

- 前端
  - 在线状态灯与文案；预热与结束按钮；
  - 订阅 `up/down` 与 `session.runtime`，初次加载拉取 `/api/chat/runtime`。

- 文档
  - SSoT：在 `docs/guide/codex-chat-ws-ssot.md` 增补 `chat.info.runtime.child_*` 定义；
  - 架构：在 `docs/guide/architecture.md` 标注 runtime 状态来源与调试手段；
  - 标准层：新增“执行器标准层（CLI/API）”文档，定义 Trait/Bridge 与对齐约束。
