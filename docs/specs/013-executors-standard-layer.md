# 执行器标准层与多 Provider 统一抽象（提案）

> 目标：在仅保留 per-conv 的前提下，统一承载“CLI/子进程型 Provider（Codex/Claude/Gemini 等）”与“LLM API 型 Provider（OpenAI/Anthropic/Gemini 等）”，以单一抽象对外提供会话运行、消息流与状态可观测，并统一桥接到平台层 `chat.*`（SSoT）。

## 1. 范围与原则

- 仅 per-conv：每个会话一个运行时（CLI 进程或 API 虚拟任务），turn 间复用，闲置回收。
- Provider 无关：统一接口/状态机/事件命名；桥接层完成“原生事件 → chat.*”映射。
- SSoT：前端只消费 `chat.*`；上线/下线为 `chat.info.runtime.child_up|down` 入环；观测快照 `session.runtime` 不入环。
- 并发安全：严禁 await 持锁；Registry 统一“取锁克隆→释放→await→回写”。

## 2. 抽象与类型

- `ailoom-executors`（标准层 crate，已落地）提供：
  - `StandardProvider`：所有 Provider 的统一 trait；
    - `new_conversation(config: SpawnConfig) -> Result<String, ProviderError>`
    - `ensure_listener(conversation_id)`：确保监听/恢复；
    - `send_user_message(conversation_id, text)`；
    - `interrupt(conversation_id)`（CLI：JSON-RPC；API：取消流/请求）；
    - `terminate(conversation_id)`：终止该会话运行时；
    - `is_alive(conversation_id)` / `pid(conversation_id)`（默认实现可返回 `false`/`None`）；
    - `runtime_snapshots()`：返回 `Vec<RuntimeSnapshot>`；
    - `subscribe_raw_events(conversation_id)`：默认 `Unsupported`，后续按需开放原生事件。
  - `SpawnConfig`：创建会话时的模型/自定义配置；
  - `RuntimeSnapshot` + `RuntimeStatus`：统一的在线状态结构；
  - `ProviderError`：包装 Provider 侧错误（Unavailable/Unsupported/Timeout/...）。
- Provider 侧桥接（Codex 先行）位于 `packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs`，负责将运行时原生事件映射为 `chat.*`；后续其它 Provider 按相同模式实现自有 bridge。
- 运行时持有：
  - CLI：`CodexProvider` 内部维护子进程句柄（`CodexClient`），并在 GC 时清理；
  - API：待新增 Provider 将持有 HTTP 流的取消句柄。

说明：新 Provider 只需实现 `StandardProvider` 并在启动时注册，即可复用 Registry/WS/REST 全路径。

## 3. Registry 与状态机

- 键：`(provider: String, conversationId: String) → Handle`（CLI 或 API）。
- 状态：`starting | running | busy | idle | terminating | offline`。
  - `starting`：运行时已创建但未 ready（例如 Codex 未收到 `sessionConfigured`）。
  - `running`：ready 且非 busy；`busy`：从“开始型事件”到“收束事件”期间。
  - `idle`：`running` 且超出无活动阈值；`terminating/offline`：回收/退出。
- 计时：`spawn/ensure/send/interrupt/resume` 刷新 `last_used_ms`；可在 `chat.turn.complete` 处再刷新一次。
- GC：
  - 环境：`AILOOM_EXEC_IDLE_MS`、`AILOOM_EXEC_GC_INTERVAL_MS`、`AILOOM_EXEC_MAX_CHILDREN`。
  - 策略：优先回收超阈值 idle；资源饱和时可“硬上限回收最久未使用且非 busy 的会话”，否则拒绝新建。

## 4. 事件与接口

- 入环：
  - `chat.info.runtime.child_up { provider, conversationId, pid?, ts, reason }`
  - `chat.info.runtime.child_down { provider, conversationId, pid?, ts, reason }`
- 不入环：
  - `session.runtime { items: [{ provider, conversationId, status, idleMs, pid? }] }`
- REST：
  - `GET /api/chat/runtime?provider=<all|codex|claude|...>`
  - `POST /api/chat/conversations/:id/warm?provider=...`
  - `DELETE /api/chat/conversations/:id/process?provider=...`
- WS：
  - 保持既有 `chat.*` 映射；新增 child_up/down 入环；`session.runtime` 走 `broadcast_ephemeral`。

## 5. API Provider 映射指引

- 文本内容：流式 delta → `chat.message.delta`（不入环）；结束 → `chat.message.completed`（入环）。
- 推理通道：`reasoning.delta`（不入环） + `reasoning.end`（入环）（若 Provider 支持）。
- 工具调用：建议平台侧实际执行（exec/patch/mcp），并产出 `chat.tool.*`；如仅提议，则以 `chat.info.*` 告知。
- 中断：HTTP 取消；按需产出 `chat.message.aborted` 或 info。

## 6. 配置与能力

- ProviderDescriptor：`id/name/version/kind('executor'|'api')/capabilities/configSchema`。
- ConversationConfig：`model/temperature/top_p/max_tokens/tools/mcpServers/...` + `extra`。

## 7. 环境变量（统一）

- `AILOOM_EXEC_IDLE_MS`、`AILOOM_EXEC_GC_INTERVAL_MS`、`AILOOM_EXEC_MAX_CHILDREN`、`AILOOM_EXEC_USE_PROC_GROUP`、`AILOOM_EXEC_RPC_TIMEOUT_MS`。

## 8. 迁移步骤

1) 落地本标准层 crate 并迁移 Codex 到 `providers/codex/*`；
2) 引入统一 Registry 与 REST/WS/SSoT；
3) 前端接入 `/api/chat/runtime` 与 `session.runtime`，增加状态灯/预热/终止；
4) 新增 API Provider（示例 OpenAI），实现最小映射；
5) 按需扩展更多 Provider（Claude/Gemini/Qwen/Cursor/Copilot）。

## 9. 风险与验证

- 并发：使用 per-cid `AsyncMutex` 防止 warm/spawn 并发；CI 开启 `clippy::await-holding-lock`。
- 入环边界：严格按 SSoT 禁止 `delta/section_break` 入环，避免 resume 噪声。
- 资源饱和：MAX_CHILDREN 策略明确；无可回收时直观报错与 UI 提示。
- 跨平台：Unix 进程组；Windows Job 对象/退化；API 型仅需请求取消。
