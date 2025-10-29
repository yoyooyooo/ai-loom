# Codex Chat WS 事件（SSoT）

本指南记录 Codex 聊天通道的事件真相（Single Source of Truth）。链路分为两段：

- Codex App Server ↔ 后端：`codex-app-server-protocol` + `jsonrpc_lite`（不携带 `"jsonrpc"` 字段）。
- 后端 ↔ 浏览器：统一用 JSON-RPC 2.0 Notification（`{"jsonrpc":"2.0","method":...,"params":...}`），由 Hub 注入 `eventId` 与 `ts`。

## 事件链路总览

- `transport.rs` 负责与 Codex App Server 的 stdin/stdout 交互，并在收到 Notification 时交给 `bridge.rs`。
- `bridge.rs` 将 `ServerNotification` 映射为一个或多个 `BroadcastEvent`，统一命名为 `codex/*`，并补充 `provider`、`conversationId` 等上下文。
- `hub.broadcast` 把 `BroadcastEvent` 包装成 JSON-RPC Notification、写入 Ring，并向所有连接推送；`chat_events.rs` 继续产生平台自有的 `chat.*` 事件（如 `chat.session.new`）。
- 浏览器侧 `ws.ts` 订阅 `notification$`，对 `codex/event/*` 做归一化映射，内部仍以历史沿用的 `chat.*` 方法驱动 UI 与 store。

关键文件：

- 后端：`packages/rust/ailoom-server/src/services/codex/{transport.rs,bridge.rs,client.rs}`、`packages/rust/ailoom-server/src/ws/{hub.rs,chat_events.rs}`。
- 前端：`packages/web/src/features/codex-chat/services/ws.ts`、`packages/web/src/lib/ws/{types.ts,rx-client.ts}`。

## 后端广播：Codex 原始事件（`codex/*`）

| 事件 | 说明 | 关键字段 |
| --- | --- | --- |
| `codex/sessionConfigured` | Codex 新建/恢复会话后的首个通知。| `provider` 固定为 `"codex"`；`sessionId`/`conversationId`；`model`；`historyLogId`、`historyEntryCount`；`rolloutPath`；`initialMessages`（`EventMsg[]`，供前端回放）；`reasoningEffort`（如存在）。|
| `codex/authStatusChange` | 身份状态发生变化（TUI 登录、凭证失效等）。| `authMethod`、`authenticated`、`provider`、可选 `conversationId`。|
| `codex/auth/loginChatGptComplete` | 登录 ChatGPT 完成（用于后续跳转或提示）。| 原始 payload 以 `payload` 字段透出。|
| `codex/account/rateLimits/updated` | 额度窗口刷新或 webhook 触发。| `rateLimits`（`RateLimitSnapshot`），附带 `remaining` / `resetAt` 供前端展示。|
| `codex/event/<EventMsg.type>` | Codex 运行时事件流，原样透出 `EventMsg`。`bridge.rs` 负责补 `provider` / `conversationId` 并把 payload 丢进 `payload` 或直接平铺在 `params` 中。| 参见下文归一化对照。|

> 提示：`bridge.rs` 会把任意未带 `codex/` 前缀的通知改写为 `codex/<method>`，并在检测到 `RateLimitSnapshot` 时自动追加一条 `codex/account/rateLimits/updated`。

### `codex/event/*` 与 `EventMsg` 对照

常见 `EventMsg.type` 与关键字段：

- `agent_message_delta` → `delta`
- `agent_message` → `message`
- `agent_reasoning_delta` / `agent_reasoning` / `agent_reasoning_section_break`
- `exec_command_begin` / `exec_command_output_delta` / `exec_command_end`
- `patch_apply_begin` / `patch_apply_end`
- `mcp_tool_call_begin` / `mcp_tool_call_end`
- `user_message`
- `web_search_begin` / `web_search_end`
- `plan_update`
- `turn_diff`
- `task_started` / `task_complete` / `turn_aborted`
- `exec_approval_request` / `apply_patch_approval_request`
- `token_count`（用于额度面板）

这些事件统一带上 `provider` 与可选的 `conversationId`，其余字段与 Codex CLI JSONL 完全一致。

示例：

```json
{
  "jsonrpc": "2.0",
  "method": "codex/event/agent_message_delta",
  "params": {
    "provider": "codex",
    "conversationId": "019a9cfa-fd52-7d05-8b58-05bc79b2d9e0",
    "delta": "分析中",
    "ts": "2025-10-24T03:12:47Z",
    "eventId": "487"
  }
}
```

## 后端广播：平台自有 `chat.*` 事件

我们的路由仍会广播若干平台自有事件，用于驱动 UI 统一处理：

- `chat.session.new`：新建会话成功（`conversationId`）。
- `chat.session.resumed`：恢复成功（`conversationId`）。
- `chat.session.history`：恢复时一次性推送历史消息（`messages: ChatHistoryEntry[]`）。
- `chat.message.delta/completed/failed/aborted`：服务端兜底处理（例如 API 抛错时，触发失败态）。
- `chat.reasoning.*`、`chat.tool.*`、`chat.info.*`、`chat.turn.complete`：复用历史聚合器。

这些事件继续由 `chat_events.rs` 产出，Hub 同样会自动补 `eventId` 与 `ts`。

## 前端归一化：`codex/event/*` → `chat.*`（Turn-first SSoT）

- 入口：`packages/web/src/features/codex-chat/services/ws.ts`。
- 前端唯一事实源（SSoT）为归一化后的 `chat.*`；UI 基于 Turn-first 模型渲染，状态保存在 `chat-turns` store（`packages/web/src/features/codex-chat/stores/chat-turns.ts`）。
- `ws.events$` 返回 JSON-RPC Notification。前端先处理平台自有 `chat.*`，再对 `codex/*` 分类：
  - `codex/sessionConfigured`：
    - 刷新 `conversationId`
    - 透出初始消息为 `chat.session.history`
    - 更新 `codex-chat-provider` store 的 `capabilities`
  - `codex/authStatusChange`、`codex/account/rateLimits/updated`：落入 provider store。
  - `codex/event/<type>`：由服务端 `map_notification_to_chat_events` 映射为对应的 `chat.*`，随后走统一的 `processChatEvent`（这些事件会在 turn-store 中聚合为 `turn.steps`）。
- `guardConversation` 确保 UI 仅消费当前激活会话的事件，未来多会话时可独立订阅（conversationId 一致）。

### 与 Turn-first Store 的对齐

- 归一化层 `chat.*` 是 UI 的唯一事实来源；turn-store 仅依赖该层。
- 事件 → Store 映射（核心动作）：
  - `chat.turn.started` → `markTurnStarted()`（缺省可省略；第一条 delta/工具到来也会触发 turn 占位）。
  - `chat.message.delta` → `appendAssistantDelta()`；`chat.message.completed` → `completeAssistant(text?)`。
  - `chat.message.failed|aborted` → `fail|abortAssistant()` 并 `completeTurn()` 兜底。
  - `chat.reasoning.delta|end|section_break` → `appendReasoning()/endReasoning()`；仅挂在当前 Turn。
  - `chat.tool.exec|patch|mcp.begin` → `addStep(kind, callId, title, meta)`；`.output` → `appendStep(callId, text)`；`.end` → `endStep(callId, patch)`。
  - `chat.info.*` → 作为 `info` 步骤进入 Working 折叠。
  - `chat.turn.complete` → `completeTurn()`（最高优先收尾）。

边界推进规则：
- 采用游标顺序回放；遇到“结束事件”（`turn.complete` 或 `message.completed|failed|aborted`）推进到下一 Turn。
- Turn 完成后清理该 Turn 的工具索引（callId→stepId），避免残留。

### 恢复（Resume）流程与 Turn-first 对齐

- HTTP 恢复端点：`POST /api/chat/conversations/resume`
  - 返回 `history: ChatHistoryEntry[]` 与 `events: Array<{ method: string; params?: object }>`。
  - `events` 为归一化后的 `chat.*` 事件；工具/信息事件会附带 `turnSeq: number`（从 1 开始，表示归属的用户轮次）。
- 前端一次性快照注入：
  - 使用 `buildTurnsFromHistory(history)` 生成 `Turn[]` 框架（每遇到 `user` 开启新 turn；`reasoning` 合并、`assistant` 收尾）。
  - 使用 `applyEventsToTurns(turns, events)` 将工具/信息事件落入对应 turn 的 `steps`：
    - 含 `turnSeq` 的事件按 `seq` 精确落位；缺失则按“当前/最后一轮”兜底。
  - 最终通过 `chatTurnActions.loadSnapshot(history, events)` 一次落库，避免逐条更新导致的重绘与重复。
- WS 历史广播防抖：仅当本地 `turns.length === 0` 时消费 `chat.session.history` 填充；避免覆盖 HTTP resume 已经注入的结果。

### 恢复（Resume）流程

- 唯一来源：`/api/chat/conversations/resume` 返回的 `history` 与 `events`（均已归一化为 `chat.*`）。
- 前端仅调用 `chatTurnActions.loadSnapshot(history, events)`，不再访问 `/debug/codex`。`/debug/codex` 保留作人工调试。
- 恢复完成后即刻订阅 `subscribeTopic('chat',{ conversationId })`，并在重连时调用 `events.resume({ topic:'chat', filter:{ conversationId }, after, tail:128 })` 补偿增量。
- 工具步骤聚合：基于 `callId` 在 Store 内维护索引，Turn 完成后清理。

幂等与去重：
- `loadSnapshot` 必须幂等，可重复应用历史与补偿事件。
- `convLast[cid]` 持久化在 localStorage；`chat.*` 按会话去重，`codex/*` 只保留必要兼容去重。
- 按会话 resume 依赖服务端 Ring 过滤；若 `after` 落后于 Ring 最老条目，返回 `truncated=true` 并提示用户。

