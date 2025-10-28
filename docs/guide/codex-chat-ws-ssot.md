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
  - `codex/event/<type>`：调用 `normalizeCodexRuntimeEvent` 映射为对应的 `chat.*`，随后走统一的 `processChatEvent`（这些事件会在 turn-store 中聚合为 `turn.steps`）。
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

### 恢复（Resume）的事件来源

- 优先使用后端在 `/api/chat/conversations/resume` 返回的 `events: Array<{ method, params }>`（推荐即为 `chat.*`）。
- 若 `events` 缺失：前端可回退请求 `/debug/codex?limit=800&includeChat=true`：
  - 仅保留 `method` 以 `chat.` 开头的事件；
  - 若 `params.conversationId` 存在，则筛选出仅与当前会话匹配的事件；
  - 将该序列与 `history` 结合，通过 `loadSnapshot(history, events)` 重建 Turn + Steps。

幂等与去重：
- `loadSnapshot` 需幂等（可重复调用）；
- 事件回放过程中基于 `callId` 聚合工具步骤；Turn 完成后清理索引。

归一化映射示例：

| EventMsg.type | 归一化后的 `chat.*` | 备注 |
| --- | --- | --- |
| `agent_message_delta` | `chat.message.delta` | 触发 explored 收束、追加 delta。|
| `agent_message` | `chat.message.completed` | 就地完成占位并写入最终文本（不再尾插“最终总结”）。|
| `agent_reasoning_delta` / `agent_reasoning` | `chat.reasoning.delta` / `chat.reasoning.end` | reasoning 会折叠显示。|
| `exec_command_begin/end/output_delta` | `chat.tool.exec.begin/end/output` | 支持读取命令自动合并为 `[explored]`。|
| `patch_apply_*` | `chat.tool.patch.*` | 默认附带 diff（受限流）。|
| `mcp_tool_call_*` | `chat.tool.mcp.*` | 透传 server/tool/arguments/result。|
| `plan_update` | `chat.info.plan_update` | 追加任务计划摘要。|
| `turn_diff` | `chat.info.turn_diff` | 传入 unified diff。|
| `task_started` / `task_complete` | `chat.turn.started` / `chat.turn.complete` | `turn.complete` 会收尾占位、工具卡、explored。|
| `token_count` | — | 不广播 `chat.*`，改写为 `capabilities.extra.tokenCount`。|

> 归一化事件仍然走统一的消息 Ring，因此断线重连会在 `events.resume` 时按 `chat.*` 顺序补发。

### 流式序列标准形态（单轮）

一个典型回合（不含工具）时间线如下（中间可能穿插 `token_count`、`rateLimits/updated`）：

1) `codex/event/user_message`（可选，回显用户输入）
2) `codex/event/task_started`（映射 `chat.turn.started`）
3) 推理阶段：
   - `codex/event/agent_reasoning_section_break`（可选，映射 `chat.reasoning.section_break`）
   - 若干条 `codex/event/agent_reasoning_delta`（映射 `chat.reasoning.delta`）
   - 可选 `codex/event/agent_reasoning`（映射 `chat.reasoning.end`）
4) 回答阶段：
   - 若干条 `codex/event/agent_message_delta`（映射 `chat.message.delta`）
   - `codex/event/agent_message`（映射 `chat.message.completed`）
5) `codex/event/task_complete`（映射 `chat.turn.complete`）

工具/补丁/MCP 会在 3) 或 4) 间穿插：

- `exec_command_begin/output_delta/end` → `chat.tool.exec.*`
- `patch_apply_begin/end` → `chat.tool.patch.*`
- `mcp_tool_call_begin/end` → `chat.tool.mcp.*`

> UI 侧行为：
> - 发送时做一次“乐观更新”：插入一条用户消息和一条“AI 正在分析…”占位。
> - 第一条 `message_delta` 到来时清除占位文案、开始拼接正文；完成时就地写入最终文本。
> - 推理信息折叠渲染；工具事件按卡片或 explored 聚合显示。

### 去重与防重复策略（前端约束）

- `codex/event/user_message`：仅用于时间线一致性/多端同步。若与“最近一条用户消息”的文本相同，则忽略，不再渲染 info 卡，避免“我→AI→我”。
- `codex/sessionConfigured.initialMessages`：仅在本地消息列表为空（典型为刷新后 resume）时回放。新建会话（fresh）跳过，避免双“我”。
- `codex/event/*` 去重：基于 `method#eventId` 去重，严格忽略 `eventId` 小于最近值的事件；允许同一 `eventId` 下不同 `method` 的帧（例如 `reasoning_delta`→`agent_message_delta`）顺序到达并全部生效。
- `chat.message.delta`：当占位气泡仍为“正在分析…”或 `placeholder=true` 时，第一条 delta 会先清空占位文案再写入，避免正文里残留“正在分析…”。
- `chat.message.completed`：只就地完成占位并写入最终文本，不再尾插“最终总结”气泡，避免双 AI。
- `guardConversation`：仅消费当前激活 `conversationId` 的事件，避免多会话串扰。

### 恢复（resume）与短时轮询（前端策略）

- `/api/chat/conversations/resume` 返回 base `history` + 归一化 `events` 与启发式 `inProgress`。
- 前端在 Store Action（建议：`chat-resume.ts/processResumeResult`）中：
  - 幂等落地 base history + events（`chatTurnActions.loadSnapshot`）；
  - 应用 provider 能力与覆盖（`codex-chat-provider`）；
  - 若 `inProgress=true`，启动短时轮询：
    - 源：推荐只读快照接口（可选）或 `/debug/codex?includeChat=1`；
    - 间隔：2.5s；连续 4 次无增量或 30s 超时即停止；
    - 结果双写：Zustand（驱动 UI）+ React Query 缓存（Key：`['chat','sessionSnapshot', conversationId]`）。

> 注：当 Codex CLI 与本后端自启 App Server 分属不同进程时，页面无法直接接收 CLI 那份实时事件。短时轮询用于“只读观察”，生产态建议尽量在页面内新建/继续会话以获得 WS 实时。

### 环境变量与阈值（建议）

- 服务端：`AILOOM_CODEX_ROLLOUT_IDLE_MS`（默认 8000）用于判断 rollout 文件“静默时间”是否超过阈值，从而辅助 `inProgress` 判定。
- 前端（可选）：
  - `VITE_CHAT_POLL_MS`（默认 2500）轮询间隔；
  - `VITE_CHAT_POLL_MAX_MS`（默认 30000）最长轮询时长；
  - `VITE_CHAT_POLL_NOCHANGE_MAX`（默认 4）无增量阈值。

## 调试与排障

- 设置 `VITE_WS_DEBUG=1` 可在浏览器控制台打印所有 `codex/*` 与 `chat.*` 事件；`VITE_WS_DEBUG_ROUTE=1` 可查看 subscribe 选项。
- `packages/web/src/lib/ws/ws-debug-panel.tsx` 提供内置调试面板，可人工注入 `codex/event/*`、`codex/sessionConfigured` 样例。
- 后端日志：
  - `codex.rpc`：与 Codex App Server 的 JSON-RPC 通信。
  - `codex.event`：归一化前的 `EventMsg`。
  - `ws`：Hub 广播记录（可通过 `AILOOM_WS_TRACE_BROADCAST=1` 打开）。
- 常见排查：
  - 仅看到 `codex/event/*`，无 `chat.*` → 检查 `normalizeCodexRuntimeEvent` 是否支持该 `EventMsg.type`。
  - `codex/sessionConfigured` 未到达 → 确认 App Server `addConversationListener` 是否成功、或 CLI 是否最新版本。
  - Rate limit 面板为空 → 检查是否设置了 `codex/event/token_count`，或 App 账号本身未开启额度统计。

### `/debug/codex` 调试端点

- 路径：`GET /debug/codex?limit=200&includeChat=true`
- 返回：
  ```jsonc
  {
    "stats": { ... HubStatsOut ... },
    "events": [ { "id": 123, "method": "codex/event/agent_message_delta", "params": {...} }, ... ]
  }
  ```
- 说明：
  - `limit`（默认 200，最大 1000）限制返回事件数量；会自动预取更大的 ring 切片以保证筛选后足够事件。
  - `includeChat` 控制是否同时返回归一化后的 `chat.*` 序列。
  - `stats` 等价于 `Hub::stats_snapshot()`，方便观测广播计数、ring 尺寸、最近 eventId 等指标。

可与浏览器调试面板、WS 控制台联合使用，快速比较原始事件与归一化事件的对应关系。

## 相关 API 与 Store

- `/api/chat/config`：返回模型列表 + 默认配置，消费端见 `codex-chat-provider.ts`。
- `/api/chat/conversations/resume`：返回 `history`、`events`（含 `turnSeq`）与 `config overrides`。前端用 `chatTurnActions.loadSnapshot` 一次注入。
- Store：`useChatTurnStore`（turn-first 时间线 + steps）+ `useCodexChatProviderStore`（能力/覆盖/模型列表）。

### 常见问题（恢复后看不到 steps）

- 检查服务端响应是否包含 `events` 且数量 > 0：
  - `curl -s -X POST http://127.0.0.1:63000/api/chat/conversations/resume | jq '{events_len:(.events|length), e0:(.events[0])}'`
- 确认 `events[].params.turnSeq` 是否存在：用于将步骤精确归属于某个 turn。
- 确认前端未被 WS 的 `chat.session.history` 覆盖：首次 `loadSnapshot` 后，WS 侧仅在本地 turns 为空时才使用 history。
- 仍异常时，开启 `VITE_WS_DEBUG=1` 并在控制台检查 `chat.tool.*` 是否正常回放。

## 示例：原始事件与归一化事件

```jsonc
// codex/event/agent_message (raw)
{
  "jsonrpc": "2.0",
  "method": "codex/event/agent_message",
  "params": {
    "provider": "codex",
    "conversationId": "019a9cfa-fd52-7d05-8b58-05bc79b2d9e0",
    "message": "最终答案",
    "ts": "2025-10-24T03:12:53Z",
    "eventId": "492"
  }
}

// 归一化后在前端触发的事件
{
  "jsonrpc": "2.0",
  "method": "chat.message.completed",
  "params": {
    "conversationId": "019a9cfa-fd52-7d05-8b58-05bc79b2d9e0",
    "text": "最终答案",
    "ts": "2025-10-24T03:12:53Z",
    "eventId": "492"
  }
}
```
- **事件分层对照**

| 层级 | 命名示例 | 主要用途 | 携带信息 |
| --- | --- | --- | --- |
| 原始 Provider 层 | `codex/sessionConfigured`、`codex/event/agent_message_delta` | 记录 Codex App Server 的事实，方便调试/多 Provider 对齐；`/debug/codex` 和 `codex-chat-provider` 都读取这一层 | `provider`、`conversationId`、`EventMsg` 原始字段、`rateLimits` 等完整 payload |
| 平台归一化层 | `chat.message.delta`、`chat.tool.patch.begin` 等 | UI & 状态机统一使用；多 Provider 只需把自己的事件归一化到这一层即可复用 UI | 在 `params` 中同时保留 `conversationId`、`providerId`（来自原始事件），以及平台态所需的 delta/text/工具信息 |

> 未来新增 Provider 时，同样采用 `<providerId>/*` → `chat.*` 的流程，只需在归一化后保留 `params.providerId` 即可区分来源。
