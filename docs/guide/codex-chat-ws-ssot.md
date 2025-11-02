# Codex Chat WS 事件（SSoT）

本指南记录 Codex 聊天通道的事件真相（Single Source of Truth）。链路分为两段：

- Codex App Server ↔ 后端：`codex-app-server-protocol` + `jsonrpc_lite`（不携带 `"jsonrpc"` 字段）。
- 后端 ↔ 浏览器：统一用 JSON-RPC 2.0 Notification（`{"jsonrpc":"2.0","method":...,"params":...}`），由 Hub 注入 `eventId` 与 `ts`。

## 历史与流统一（按会话 Resume）

- 单一路径：实时 WS 与断线补偿均产出同构的“平台层 `chat.*` 事件”。前端只维护一套 Turn-first reducer。
- 入环与去重：所有“可见增量”的 `chat.*` 事件进入 Ring，Hub 自动注入 `eventId/ts`；前端以每会话 `convLast[cid]` 做去重与断点恢复。
- 按会话 Resume：`events.resume({ topic:'chat', filter:{ conversationId }, after, tail })` 仅返回该会话的 `chat.*` 增量；`after==0` 时可携带 `tail` 返回近况，`after>0` 时忽略 `tail`。
- 历史骨架：HTTP Resume 负责启动/建联与返回稳定快照（`turns`，可选 `config/in_progress`）。为避免重复重放增量，响应不再返回 `events/history`，提供：
  - `uptoEventId`：用于前端推进会话游标
  - `turnsSchemaVersion`：当前为 1，后续演进以版本兼容
  - 大输出脱水：对 `exec/patch` 正文超限时，turns 中相应步骤将附带 `meta.truncated=true` 与 `meta.outputBlobId`，可调用 `GET /api/chat/output?conversationId&blobId` 拉取完整正文
  - Blob 存储位置：显式 `AILOOM_CHAT_BLOB_DIR`（需绝对路径）优先，其次 `~/.ailoom/resume-blobs/<conversationId>/`，再回退工作区 `.ailoom/resume-blobs/<conversationId>/`；HTTP 拉取逻辑沿用同一优先级顺序。

配置与默认值（实现一致）：
- `AILOOM_WS_RING_CAP`（事件条数）：默认 4096，可按流量进一步上调。
- `events.resume.tail`：前端按需传入，常用 128；仅 `after==0` 时生效。
- 其余开关参见 `docs/guide/ws-overview.md`（`VITE_WS_DEBUG*`、`AILOOM_WS_EAGER_SAVE_ECHO` 等）。
  - gating 诊断：`AILOOM_WS_GATING_DEBUG`（0/1），默认关闭；`AILOOM_WS_GATING_AGG`（0/1）控制是否按 1s 聚合输出。
  - 订阅保障：`AILOOM_WS_AUTO_ENSURE_CODEX`（0/1），启用后对首次订阅会话（0→1）主动 `ensure_listener`。

## 订阅握手（WS 订阅即补发）

为降低前端 Resume 复杂度、支持多会话并发渲染，WS 增加“订阅握手”机制：

 - RPC：
   - `subscribe({ topic, filter, after?, tail? })`
   - `subscribeMany({ items: Array<{ topic, filter, after?, tail? }> })`（可选优化，前端可用 `VITE_WS_SUBSCRIBE_BATCH=1` 启用；后端不支持时前端会自动回退为逐条 `subscribe`）
   - 仅当 `topic=="chat"` 时启用“订阅即补发”，其它主题维持原样。
- 握手流程：服务端在“同连接、相同 `topic+filter` 的订阅”引用计数从 0→1 时，按以下顺序发送三段消息：
  1) `chat.session.sync_begin{ conversationId?, providerId?, after, tail }`
  2) 稳定事件补发（仅入环的 `chat.*`，不含 `delta/section_break` 等瞬时事件）
  3) `chat.session.sync_end{ conversationId?, providerId?, uptoEventId, truncated }`
     - `uptoEventId` 定义：本次补发中“已成功写出”的最大 `eventId`，而非仅“待发送列表中的最大值”。这保证前端据此推进“已应用游标”后，后续 resume/直通不会出现“游标超前”。实现上服务端在补发结束后短窗轮询写出游标（≤100ms），以“已写出值 ∨ after”为最终 `uptoEventId`。
- 仅在 0→1 触发：重复订阅同一 token（相同 `topic+filter`）只增加 `ref_count`，不重复补发；`unsubscribe{token}` 计数减 1，直至归零才真正移除，下一次再订阅才会再次触发握手。
- 过滤与游标：
  - `filter` 支持 `conversationId` 与可选 `providerId|provider`；握手补发与之后的实时分发均按该过滤生效。
  - `after>0` 走 `resume_after_chat(after, filter)`；`after==0` 且 `tail>0` 走 `tail_chat(filter, tail)`；`uptoEventId` 取本次补发事件的最大 `eventId`（无事件时为 `after`）。
  - 被截断返回 `truncated=true` 并建议触发 `session.resync`，由前端做 UI 提示或重拉（不强制）。
  - 会话标识严格化：桥接层仅对“显式带 `conversationId` 的 Codex 通知”产出 `chat.*`；缺失会话 id 的 `chat.*` 会被丢弃（不入环），以避免多会话并发时的串流与误回放。

前端约定：

- 已应用游标：维护“已应用到 UI 的会话游标 `convAppliedLast[cid]`”，优先用于 `subscribe(chat)` 的 `after`；如无，则回退“已看到游标 `convLast[cid]`”。两者均持久化在 `localStorage`（按 WS 主机名命名空间隔离）。
- 事件对齐：处理 `chat.session.sync_end{ uptoEventId }` 时，用 `ws.primeConversationCursor(conversationId, uptoEventId)` 推进“已应用游标”，保证握手补发与后续实时事件不重不漏。
- 多视图并发：多个组件可分别 `subscribe(chat,{conversationId})`，同一连接内相同 token 共享一个后端订阅（ref_count>1），互不重复补发；任一视图卸载只做计数减 1，不影响其余视图。
  - 批量订阅：同一时刻需要新增多个 token 时，前端可调用 `subscribeMany` 一次性建立多条订阅；其中仅“首次建立（0→1）”的 token 会触发握手补发，每条补发均包含 `sync_begin → chat.* → sync_end{uptoEventId}`。

### 前端配线（RxJS）与处理层（Store）

- 单一入口：前端只消费平台层 `chat.*`；配线层（RxJS 管道）负责握手窗口缓冲与事件分流；处理层（Store/Reducers）只做 Turn-first 聚合。
- 握手窗口与 UI：
  - `sync_begin → sync_end` 期间按“会话维度”缓冲稳定事件（升序一次性 flush）；增量 `delta` 始终直通，避免撕裂与等待。
  - UI 的“正在加载/同步中”严格等价于握手窗口；窗口外实时直通，避免闪烁。
- 无空窗发送：
  - 发送首条消息前，前端通过 `ensureChatReady$(cid)`（using + race(sync_begin, fastReady)）声明式等握手就绪，并在持有订阅的周期内完成发送，消除“发送先于订阅”的竞态。
  - 会话面板挂载时建立稳定订阅（按路由会话），切换自动交接；同一路由视图卸载自动退订（后端 ref_count 归零触发真正移除）。

### 稳态与自愈（实现约定）

- 写出微批与空闲 flush：≥16 条或每 50ms 刷一次；flush 连续 3 次超时才关闭（避免一次抖动早退）。
- 回放节奏控制：每 32 条 yield；每 128 条 sleep 1ms，防止回放挤占 live；必要时服务端优先保证 live。
- 泵（PULL）只兜底：仅在 `Hub.lastEventId > max(last_sent, last_scanned)` 时补；补到的最大 id 记为 `last_scanned`，即使被 gating 过滤也不会重复扫描。
- 断线/空窗自愈：
  - 发送后 1.5s 无该会话 `chat.*` → 服务端自动 `refresh_listener(conversationId)` 一次（幂等/去抖）。
  - WS 重连后 ~1.2s，对“进行中且最近无事件”的会话触发一次 `refresh_listener`，快速恢复监听。

注意：

- 服务器只对 `topic:"chat"` 启用“订阅即补发”，且要求 `filter.conversationId` 存在；`chat:{}` 不会触发历史补发，避免“全站历史”误重放。
- Hub 广播 gating：除 `file/tree/annotations/session.resync` 之外，其它事件（含 `chat.*`）必须命中某个订阅才会转发到连接，减少无关噪音与泄漏风险。

## 事件链路总览

- `transport.rs` 负责与 Codex App Server 的 stdin/stdout 交互，并在收到 Notification 时交给 `bridge.rs`。
- `bridge.rs` 将 `ServerNotification` 映射为一个或多个 `BroadcastEvent`，统一命名为 `codex/*`，并补充 `provider`、`conversationId` 等上下文。
- `hub.broadcast` 把 `BroadcastEvent` 包装成 JSON-RPC Notification、写入 Ring，并向所有连接推送；`chat_events.rs` 继续产生平台自有的 `chat.*` 事件（如 `chat.session.new`）。
- 浏览器侧 `ws.ts` 订阅 `notification$`，对 `codex/event/*` 做归一化映射，内部仍以历史沿用的 `chat.*` 方法驱动 UI 与 store。

关键文件：

- 后端：`packages/rust/ailoom-server/src/services/codex/{transport.rs,bridge.rs,client.rs}`、`packages/rust/ailoom-server/src/ws/{hub.rs,chat_events.rs}`。
- 前端：
  - 配线与握手窗口：`packages/web/src/features/codex-chat/services/ws.ts`、`packages/web/src/features/codex-chat/services/ws-pipeline.ts`
  - 处理器入口与分层：`packages/web/src/features/codex-chat/services/processors/index.ts`（session/message/reasoning/turn/tools/info）

### 前端配线与处理器边界（RxJS → Store）

- 配线层（RxJS）：负责握手窗口、分流与 UI 辅助信号，不直接写 Store。
- `buildChatPipeline(events$, { enableBuffer })`：
    - 以 `sync_begin/end` 为窗口边界，窗口内缓冲 → 依 `eventId` 升序一次性回放；窗口外实时直通。
    - 返回 `{ chat$, syncEnd$ }`：`chat$` 仅含稳定入环事件（不含 `chat.reasoning.delta|section_break`/`chat.turn.started`）。
  - `ws.ts` 订阅：
    - `sync_begin` → `useChatHydrationStore.setHydrating(conversationId, true)`（驱动“正在加载会话…”）；
  - `sync_end` → `useChatHydrationStore.setHydrating(conversationId, false)` 与 `ws.primeConversationCursor(conversationId, uptoEventId)`；
    - `chat$` → 逐条委托给处理器入口（见下）。

```ts
// 摘录自 packages/web/src/features/codex-chat/services/ws.ts
const { chat$: hydratedChat$, syncEnd$ } = buildChatPipeline(ws.events$, {
  enableBuffer: true,
  // 严格模式：begin→end 期间全局不直通（仅在强一致 UI 需要时开启）
  strictBuffer: false
})
syncEnd$.subscribe(({ params }) => {
  const cid = params?.conversationId
  const upto = Number(params?.uptoEventId || 0)
  if (cid) useChatHydrationStore.getState().setHydrating(cid, false)
  if (cid && upto > 0) ws.primeConversationCursor(cid, upto)
})
hydratedChat$.subscribe(({ method, params }) => {
  chatTurnActions.__beginFor(params?.conversationId)
  try { processor(method, params) } finally { chatTurnActions.__endEvent() }
})
```

- 处理层（Store Reducers）：纯函数式映射，负责“事件 → turns/steps”的落库。
  - 入口：`processors/index.ts`，内部依次分派到：
    - `session.ts`（会话选中、history 填充）
    - `message.ts`（delta/completed/failed/aborted，含 Compact 特例）
    - `reasoning.ts`（delta/end/section_break 去冗余）
    - `turn.ts`（turn.started/turn.complete 边界）
    - `tools.ts`（exec/patch/mcp；read/list/search 元信息与 apply_patch 识别）
    - `info.ts`（plan_update/approval/*/background 等）

- 稳定事件清单（入环，支持握手回放）：
  - `chat.message.*`（completed/failed/aborted），`chat.reasoning.end`，`chat.tool.*`，`chat.info.*`，`chat.turn.complete`
  - 非入环（不参与握手回放）：`chat.turn.started`、`chat.reasoning.delta|section_break`

- Hydration 与 UI：
  - “正在加载会话…” 严格等价于握手窗口（`sync_begin → sync_end`）。
  - `delta` 始终直通（不参与握手窗口的缓冲）；若 `message.completed/turn.complete` 已落地，迟到的“尾段 delta”由前端按结尾匹配丢弃，避免重复开新气泡。

### 前端订阅治理（意图流 × 在线状态）

- 目标：以更 RxJS 的方式收口订阅生命周期，消除手写 Map/Set 计数与重复订阅风险；与后端“订阅握手（0→1 补发、>1 不补发）”契合。
- 模型：
  - `subscribeTopic$(topic, filter)` 返回按 token（`topic+filter` 规范化）记忆化的共享 Observable。
  - 订阅/退订仅发送“意图”（`retain/release`），由 `intent$ → desired(set)` 聚合与 `online$`（连接状态）共同驱动实际的 `subscribe/unsubscribe` RPC。
  - 0→1：首次 retain 时触发服务端订阅（带 `after/tail` 参数）；>1：共享同一后端订阅；1→0：去抖退订后真正 `unsubscribe`。
- after/tail 注入：
  - `after` 优先取 `convAppliedLast[cid]`，回退 `convLast[cid]`，并以 `serverLastEventId` 夹取上限；若 `after==0` 则默认 `tail=128`。
  - 处理 `sync_end{uptoEventId}` 时用 `primeConversationCursor(cid, uptoEventId)` 推进“已应用游标”。
- 去抖退订：
  - 配置 `VITE_WS_UNSUB_DEBOUNCE_MS`（默认 250ms）；1→0 后延迟触发 `unsubscribe`，若期间再次 0→1 则取消定时器并保留订阅。
  - 断线时清空本地 `subscribedTokens` 与所有去抖定时器；重连后按 desired 集合“只补缺”订阅，避免重复补发。

示例（伪码）：

```
const sub = ws.subscribeTopic$('chat', { conversationId: cid }).subscribe(ev => process(ev))
// 组件卸载即自动 release；多视图共享同一 token，不会重复补发
```

  - 同一连接内相同订阅 token 的后续订阅不会重复触发握手；第二个视图会即时接入实时流。

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

## 运行时模型：每会话子进程（Per‑Conversation）

为彻底消除“监听黑洞”与跨会话干扰，后端将 Codex 会话运行时改为“每个会话 1 个子进程”的模型，对前端与 WS 协议完全透明：

- 单 WS + 统一 chat.* 不变：握手（`sync_begin/end`）、gating、入环/去重、按会话 resume 语义全部保持一致；只是 Codex 进程从单例换成了“按会话隔离”。
- 生命周期
  - 新建：`spawn_new` → Codex `newConversation` → `addConversationListener` → 广播 `chat.session.new`
  - 发送：若已有子进程，直接 `ensure_listener + sendUserMessage`；否则自动 `resume` 并建立监听后再发送
  - 中断：`interrupt`（软）仅请求 Codex 停止当轮；`hard` 仅终止该会话子进程（不影响其它会话）
- 资源治理
  - Idle GC：`AILOOM_CODEX_CHILD_IDLE_MS`（默认 60000ms）超过阈值未使用的子进程将被回收
  - 上限：`AILOOM_CODEX_MAX_CHILDREN`（默认 6），超限时按“最久未使用且超过 idle 阈值”优先回收
  - 轮询：`AILOOM_CODEX_CHILD_GC_INTERVAL_MS`（默认 5000ms）
- 握手异步化（重要）
  - `subscribe/subscribeMany` 在 0→1 仅返回 token，握手（`sync_begin → 回放 → sync_end`）在后台任务异步投递优先通道通知，避免请求路径阻塞
  - `uptoEventId` 仍等价于“已写出”的最大 eventId（短窗≤100ms），确保游标不会超前
- 观测与调试
  - `/debug/codex` 增加 `registryChildren: [{ conversationId, pid, lastUsedMs, idleMs }]`
  - `/debug/ws` 返回每条 WS 连接的订阅快照（`token/refCount/topic/filter`）

### 配置清单（与本节相关）

- 子进程与 GC：
  - `AILOOM_CODEX_CHILD_IDLE_MS`（默认 60000）
  - `AILOOM_CODEX_MAX_CHILDREN`（默认 6）
  - `AILOOM_CODEX_CHILD_GC_INTERVAL_MS`（默认 5000）
- 订阅/握手治理：
  - `AILOOM_WS_AUTO_ENSURE_CODEX`（0/1，默认 0）：首次订阅会话（0→1）时后台 `ensure_listener`，缩短“订阅→收到实时”的窗口
  - `AILOOM_WS_UNSUB_GRACE_MS`（默认 300）：退订宽限（1→0 后延迟真正移除，防抖动）
- Writer 调度（避免回放饿死 live）：
  - `AILOOM_WS_WRITER_LIVE_QUOTA`（默认 16）、`AILOOM_WS_WRITER_FILE_QUOTA`（默认 16）

> 备注：早期的“强自愈”开关（叠加监听 + 短窗弱去重）在 per‑conv 下通常不再需要；若极端环境仍有网络抖动，可保持：`AILOOM_CODEX_STRONG_SELF_HEAL=1` 与 `AILOOM_CODEX_STRONG_DEDUP_MS=1500`。

## 后端广播：平台自有 `chat.*` 事件

我们的路由仍会广播若干平台自有事件，用于驱动 UI 统一处理：

- `chat.session.new`：新建会话成功（`conversationId`）。
- `chat.session.resumed`：恢复成功（`conversationId`）。
- `chat.session.history`：恢复时一次性推送历史消息（`messages: ChatHistoryEntry[]`）。
- `chat.message.delta/completed/failed/aborted`：服务端兜底处理（例如 API 抛错时，触发失败态）。
- `chat.reasoning.*`、`chat.tool.*`、`chat.info.*`、`chat.turn.complete`：复用历史聚合器。

这些事件继续由 `chat_events.rs` 产出，Hub 同样会自动补 `eventId` 与 `ts`。

### 事件分类索引

- 会话事件：`chat.session.new`（入环）、`chat.session.resumed`（不入环）、`chat.session.history`（不入环）
- 消息事件：`chat.message.delta|completed|failed|aborted`（入环）
- 推理事件：`chat.reasoning.end`（入环）、`chat.reasoning.delta|section_break`（不入环）
- 工具事件：`chat.tool.exec.*` / `chat.tool.patch.*` / `chat.tool.mcp.*`（入环）
- 信息/元提示：`chat.info.*`（入环；见下文清单）
- 回合边界：`chat.turn.started`（不入环）、`chat.turn.complete`（入环）

说明：不入环（ephemeral）事件仅直播，不参与 `events.resume`；入环事件均可按会话增量恢复。

### 事件分类索引（表）

| 类别 | 方法（前缀/列举） | 入环 | 可 Resume | 关键字段（摘要） | 示例 |
| --- | --- | --- | --- | --- | --- |
| 会话 | `chat.session.new` | 是 | 是 | `conversationId` | [会话事件](./chat-ws-mock-examples.md#mock-session) |
| 会话 | `chat.session.resumed`/`chat.session.history` | 否 | 否 | `conversationId`、`messages` | [会话事件](./chat-ws-mock-examples.md#mock-session) |
| 消息 | `chat.message.delta` | 是 | 是 | `delta` | [答案/失败/中止](./chat-ws-mock-examples.md#mock-message) |
| 消息 | `chat.message.completed` | 是 | 是 | `text?` | [答案/失败/中止](./chat-ws-mock-examples.md#mock-message) |
| 消息 | `chat.message.failed` | 是 | 是 | `error.message` | [答案/失败/中止](./chat-ws-mock-examples.md#mock-message) |
| 消息 | `chat.message.aborted` | 是 | 是 | `reason?` | [答案/失败/中止](./chat-ws-mock-examples.md#mock-message) |
| 推理 | `chat.reasoning.delta`/`section_break` | 否 | 否 | `delta` | [思考通道](./chat-ws-mock-examples.md#mock-reasoning) |
| 推理 | `chat.reasoning.end` | 是 | 是 | `text` | [思考通道](./chat-ws-mock-examples.md#mock-reasoning) |
| 工具 | `chat.tool.exec.begin`/`output`/`end` | 是 | 是 | `cwd?`、`command[]`、`callId?`、`exitCode?` | [Exec 工具](./chat-ws-mock-examples.md#mock-exec) |
| 工具 | `chat.tool.patch.begin`/`end` | 是 | 是 | `files`、`autoApproved`、`firstPath?`、`adds?/dels?`、`changes?`、`success` | [Patch 工具](./chat-ws-mock-examples.md#mock-patch) |
| 工具 | `chat.tool.mcp.begin`/`end` | 是 | 是 | `server`、`tool`、`arguments?`、`result?` | [MCP 工具](./chat-ws-mock-examples.md#mock-mcp) |
| 信息 | `chat.info.user_message` | 是 | 是 | `text`、`kind?` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.plan_update` | 是 | 是 | `plan`、`explanation?` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.turn_diff` | 是 | 是 | `diff` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.approval.exec`/`patch` | 是 | 是 | `callId?`、`command[]?`、`cwd?`、`reason?`、`grantRoot?`、`changeCount` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.web_search.begin`/`end` | 是 | 是 | `callId?`、`query?` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.view_image` | 是 | 是 | `callId?`、`path` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.conversation_path` | 是 | 是 | `path` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 信息 | `chat.info.review.entered`/`exited` | 是 | 是 | `{}` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |
| 回合 | `chat.turn.started` | 否 | 否 | `{}` | —— |
| 回合 | `chat.turn.complete` | 是 | 是 | `{}` | [信息与回合结束](./chat-ws-mock-examples.md#mock-info) |

提示：上表仅为“目录索引”，详细字段说明见各分节（会话/消息/推理/工具/信息/回合）以及《Chat WS 事件 Mock 示例》中的对照样例。

### 会话事件（Session）

- `chat.session.new`（入环）
  - 用途：新建会话成功，通知前端绑定 `conversationId`。
  - params：`{ conversationId: string }`
- `chat.session.resumed`（不入环）
  - 用途：HTTP resume 成功后的骨架通知。
  - params：`{ conversationId: string }`
- `chat.session.history`（不入环）
  - 用途：恢复时一次性推送历史消息（用于首屏骨架/回退）。
  - params：`{ conversationId: string, messages: ChatHistoryEntry[] }`

### 消息事件（Message）

- `chat.message.delta`（入环）
  - params：`{ delta: string }`
- `chat.message.completed`（入环）
  - params：`{ text?: string }`
- `chat.message.failed`（入环）
  - params：`{ error: { message: string } }`
- `chat.message.aborted`（入环）
  - params：`{ reason?: string }`（可能值示例：`hard_stop` 表示由后端 watchdog 触发的强制终止）

### 推理事件（Reasoning）

- `chat.reasoning.delta`（不入环）
  - params：`{ delta: string }`
- `chat.reasoning.section_break`（不入环）
  - params：`{}`
- `chat.reasoning.end`（入环）
  - params：`{ text: string }`

### 工具事件（Tool）

- `chat.tool.exec.begin`（入环）
  - params：`{ cwd?: string, command: string[], callId?: string }`
- `chat.tool.exec.output`（入环）
  - params：`{ callId?: string, stream?: 'stdout'|'stderr', text: string }`
- `chat.tool.exec.end`（入环）
  - params：`{ callId?: string, exitCode?: number, durationMs?: number, stdout?: string, stderr?: string }`
- `chat.tool.patch.begin`（入环）
  - params：`{ callId?: string, files: number, autoApproved: boolean, firstPath?: string, adds?: number, dels?: number, changes?: object }`
- `chat.tool.patch.end`（入环）
  - params：`{ callId?: string, success: boolean, stdout?: string, stderr?: string }`
- `chat.tool.mcp.begin`（入环）
  - params：`{ callId: string, server: string, tool: string, arguments?: any }`
- `chat.tool.mcp.end`（入环）
  - params：`{ callId: string, server: string, tool: string, arguments?: any, result: any }`

### 迷你 Schema（TypeScript 提要）

```ts
// 会话
type ChatSessionNew = { conversationId: string }
type ChatSessionResumed = { conversationId: string }
type ChatSessionHistory = { conversationId: string; messages: Array<{ role: 'user'|'assistant'|'reasoning'; text: string; reasoning?: string|null }> }

// 消息
type ChatMessageDelta = { delta: string }
type ChatMessageCompleted = { text?: string }
type ChatMessageFailed = { error: { message: string } }
type ChatMessageAborted = { reason?: string }

// 推理
type ChatReasoningDelta = { delta: string }
type ChatReasoningEnd = { text: string }

// 工具
type ChatToolExecBegin = { cwd?: string; command: string[]; callId?: string }
type ChatToolExecOutput = { callId?: string; stream?: 'stdout'|'stderr'; text: string }
type ChatToolExecEnd = { callId?: string; exitCode?: number; durationMs?: number; stdout?: string; stderr?: string }
type ChatToolPatchBegin = { callId?: string; files: number; autoApproved: boolean; firstPath?: string; adds?: number; dels?: number; changes?: Record<string, unknown> }
type ChatToolPatchEnd = { callId?: string; success: boolean; stdout?: string; stderr?: string }
type ChatToolMcpBegin = { callId: string; server: string; tool: string; arguments?: unknown }
type ChatToolMcpEnd = { callId: string; server: string; tool: string; arguments?: unknown; result: unknown }

// 信息/元提示
type ChatInfoUserMessage = { text: string; kind?: unknown }
type ChatInfoPlanUpdate = { plan: unknown; explanation?: string }
type ChatInfoTurnDiff = { diff: string }
type ChatInfoApprovalExec = { callId?: string; command?: string[]; cwd?: string; reason?: string }
type ChatInfoApprovalPatch = { callId?: string; reason?: string; grantRoot?: string; changeCount: number }
type ChatInfoWebSearchBegin = { callId?: string }
type ChatInfoWebSearchEnd = { callId?: string; query?: string }
type ChatInfoViewImage = { callId?: string; path: string }
type ChatInfoConversationPath = { path: string }
type ChatInfoReviewEntered = {}
type ChatInfoReviewExited = {}
type ChatInfoRuntimeChildUp = { provider: string; conversationId: string; pid?: number; reason?: string }
type ChatInfoRuntimeChildDown = { provider: string; conversationId: string; pid?: number; reason?: string }
```

### `chat.info.*` 事件清单（入环，可 resume）

- `chat.info.user_message`
  - 用途：用户消息骨架/提示（时间线一致性、多端同步）。
  - params：`{ text: string, kind?: any }`。
- `chat.info.plan_update`
  - 用途：计划卡片更新（前端渲染为 step.kind=`plan`）。
  - params：`{ plan: any, explanation?: string }`。
- `chat.info.turn_diff`
  - 用途：当前回合 diff 提示（统一 diff 字符串）。
  - params：`{ diff: string }`。
- `chat.info.approval.exec`
  - 用途：命令执行审批提示（已在后端自动批准，仍提示 UI）。
  - params：`{ callId?: string, command?: string[], cwd?: string, reason?: string }`。
- `chat.info.approval.patch`
  - 用途：补丁应用审批提示。
  - params：`{ callId?: string, reason?: string, grantRoot?: string, changeCount: number }`。
- `chat.info.web_search.begin`
  - 用途：Web 搜索开始。
  - params：`{ callId?: string }`。
- `chat.info.web_search.end`
  - 用途：Web 搜索结束。
  - params：`{ callId?: string, query?: string }`。
- `chat.info.view_image`
  - 用途：查看图片提示。
  - params：`{ callId?: string, path: string }`。
- `chat.info.conversation_path`
  - 用途：展示 rollout/history 位置，方便调试/回放。
  - params：`{ path: string }`。
- `chat.info.background`
  - 用途：通用后台提示。用于“自动强制停止 + 热切换”完成后的用户提示。
  - params：`{ message: string, code?: string }`（当 `code==='engine_swapped'` 时，前端可弹出非阻断提示）。
- `chat.info.review.entered` / `chat.info.review.exited`
  - 用途：进入/退出审查模式。
  - params：`{}`（无 payload）。
- `chat.info.runtime.child_up`
  - 用途：Provider 运行时（子进程/虚拟任务）上线（可 resume）。
  - params：`{ provider, conversationId, pid?, reason? }`。
- `chat.info.runtime.child_down`
  - 用途：Provider 运行时下线（显式 kill/GC/异常退出/取消）（可 resume）。
  - params：`{ provider, conversationId, pid?, reason? }`。

说明：以上 `chat.info.*` 均通过 `hub.broadcast` 入环；`params` 统一注入 `provider` 与可用的 `conversationId`，可被 `events.resume` 按会话补偿。

### 入环与不入环清单（权威）

## 前端分片镜像与新建页语义（实现约定）

为彻底避免“多会话并行时的串流/串台”，前端对 `chat.*` 事件按会话分片管理，并遵循如下约定：

- 分片存储：以 `byConv[cid]` 存储每个会话的 `turns/steps/toolIndex/generating` 等，视图字段镜像当前会话分片。
- 事件上下文：WS 处理器在分发 `chat.*` 事件前注入事件上下文（`__eventCid=params.conversationId`），所有 store 动作优先写入该分片；处理后清除上下文。
- 新建页（未选择会话）策略：
  - 未选择会话时，允许接收首个会话的事件（临时 `provisionalId`）以镜像渲染该分片，但不设置 `conversationId`；仅 `chat.session.*` 可显式设置会话。
  - 多个背景会话并行时，仅首个抵达的会话会被镜像，避免 UI 闪烁与“谁先写谁占用”。
- 快照与 Resume：
  - `loadFromHistory` / `loadSnapshot` 在事件上下文中按 `__eventCid` 注入到目标分片，并在当前会话时镜像到视图字段；避免覆盖其它会话。
  - `chat.session.history` 仅在本地无 `turns` 时用于填充（避免覆盖 resume 步骤）。
- 工作状态：
  - `finalMessageStarted` 仅用于 UI 派生 Working 关闭时机；`turn.status` 的收束由 `chat.message.completed|failed|aborted|chat.turn.complete` 决定。

### 分片 LRU 回收

- 默认最多保留 30 个会话分片（`VITE_CHAT_TURNS_MAX_SLICES` 可覆盖）。
- 回收策略：
  - 永不回收：当前会话（`conversationId`）、当前事件上下文（`__eventCid`）。
  - 不回收 generating=true 的分片（进行中）。
  - 其余按 `lastAccess` 升序回收最旧，直到不超过上限。
- 回收仅影响前端内存；被回收会话在需要时由 Resume/WS 自动恢复渲染。

实现位置（参考）：

- 事件订阅与上下文包裹：`packages/web/src/features/codex-chat/services/ws.ts:1`
- 分片存储与动作：`packages/web/src/features/codex-chat/stores/chat-turns-core.ts:1`
- 快照分片注入：`packages/web/src/features/codex-chat/stores/chat-turns-snapshot-slice.ts:1`
- 视图镜像（渲染切片）：`packages/web/src/features/codex-chat/components/turns-panel.tsx:1`

验证要点：

- A/B 两会话并行生成，切到 C：A 完成后切回 A，B 完成后切到 B，均显示各自完整一轮（含用户气泡）。
- 刷新后历史列表正确标出每个进行中的会话（`inProgress` 由后端聚合提供），并在会话页回显对应分片。
- /chat 新建页收到其它会话 `chat.*` 不设置 `conversationId`，仅 `chat.session.*` 允许设置。
- 入环（可增量补偿）：
  - 文本：`chat.message.delta|completed|failed|aborted`
  - 推理收尾：`chat.reasoning.end`
  - 工具：`chat.tool.exec.begin|output|end`、`chat.tool.patch.begin|end`、`chat.tool.mcp.begin|end`
  - 信息与元提示：`chat.info.*`（如 `plan_update`/`turn_diff`/`approval.*`/`background`/`view_image`/`conversation_path` 等）
  - 收束：`chat.turn.complete`

- 不入环（ephemeral，仅直播）：
  - `chat.turn.started`
  - `chat.reasoning.delta`、`chat.reasoning.section_break`
  - 观测类：`session.stats`、能力/认证类 `codex/*`

说明：不入环事件不会生成 `eventId`，也就不会参与 `events.resume` 的补偿逻辑。

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

### 会话选择与事件守卫（前端策略）

- 仅 `chat.session.*`（`new|resumed|history`）具备“设置/确认当前会话”的资格；普通 `chat.*`（如 `message.*`/`tool.*`）不会改变当前选中会话。
- 当处于 `/chat` 新建页（无选中会话）时，后台其它会话的 `chat.*` 不会抢占 UI；只有 `chat.session.*` 会显式设置 `conversationId`。
- 多来源设置会话时采用明确的优先级（由高到低）：
  - 路由/用户显式选择（route）
  - 新建会话成功返回（new）
  - 恢复成功（resume）
  - WS `chat.session.*`（ws）
  - 本地存储回填（local）
  低优先级不会覆盖高优先级来源（实现：`selectConversation(reason)`）。

### 流式 Delta 微批（RxJS）

- 目的：降低高频事件导致的主线程压力与重排，确保流畅性；不影响 SSoT 与事件语义。
- 默认开启（`VITE_CHAT_BATCH_MS`，默认 16ms），在 Vitest 环境自动关闭以保持确定性。
- 覆盖范围：
  - `chat.message.delta` → 合并为一条 `appendAssistantDelta(joined)`
  - `chat.reasoning.delta` → 合并为一条 `appendReasoning(joined)`（仍不入环）
  - `chat.tool.exec.output` → 合并为一条 `appendStep(callId, joined)`（按会话+`callId` 分组）
- 去重约束：当某轮次已收到对应的 `chat.message.completed` 时，后续迟到的 delta 需比较 `eventId` 与 turn 元数据中的 `assistantCompletedEventId`，仅当 `eventId` 更大（或正文存在新增尾部）才继续写入；否则丢弃，避免重复开启 Turn。
- 与同步处理的关系：启用 Rx 微批时，同步处理器不再逐条处理 `exec.output`，避免重复。
- 配置项：
  - `VITE_CHAT_BATCH_MS`：微批时间窗（ms，默认 16）

### 工具输出的可视化与上限

- 为避免超大输出卡死，前端对步骤正文（`step.body`）施加长度上限 `VITE_CHAT_TOOL_MAX_OUTPUT_CHARS`（默认 100000）。
  - 超限时仅渲染前/后片段，中间以 `…(truncated, total=xxxx)` 标记；并在 `step.meta` 写入 `{ truncated: true, totalLength, maxLength }`。
- 完整输出并未丢失：
  - 前端维护影子缓存（内存态，不入 Store，不跨刷新），以 `callId`（退化为 stepId）为键累积完整输出，供用户“查看完整输出”。
  - UI 在步骤卡片提供“查看完整输出（可能很长）”的展开按钮；展开后从影子缓存读取，不触发全量重渲染。
- 该策略属于表现层优化，不改变 `chat.*` 事件与 SSoT；如需持久化完整输出，可扩展为“保存为文件/链接”的后续能力。

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
  - 返回 `history: ChatHistoryEntry[]` 与 `events: Array<{ method: string; params?: object }>`（兼容用途，主增量交由 WS）。
  - `events` 为归一化后的 `chat.*` 事件；工具/信息事件会附带 `turnSeq: number`（从 1 开始，表示归属的用户轮次）。
- 前端一次性快照注入：
  - 使用 `buildTurnsFromHistory(history)` 生成 `Turn[]` 框架（每遇到 `user` 开启新 turn；`reasoning` 合并、`assistant` 收尾）。
  - 使用 `applyEventsToTurns(turns, events)` 将工具/信息事件落入对应 turn 的 `steps`：
    - 含 `turnSeq` 的事件按 `seq` 精确落位；缺失则按“当前/最后一轮”兜底。
  - 最终通过 `chatTurnActions.loadSnapshot(history, events)` 一次落库，避免逐条更新导致的重绘与重复。
- WS 历史广播防抖：仅当本地 `turns.length === 0` 时消费 `chat.session.history` 填充；避免覆盖 HTTP resume 已经注入的结果。

-### 恢复（Resume）流程

- 唯一事实源：`/api/chat/conversations/resume` 的历史骨架配合 WS `events.resume` 的增量补偿。
- 前端通过 `chatTurnActions.loadSnapshot(history, events)` 注入快照（`events` 主要用于工具/信息落位），随后订阅并使用 `events.resume({ topic:'chat', filter:{ conversationId }, after, tail:128 })` 做增量补偿。
- 工具步骤聚合：基于 `callId` 在 Store 内维护索引，Turn 完成后清理。

幂等与去重：
- `loadSnapshot` 必须幂等，可重复应用历史与补偿事件。
- `convLast[cid]` 持久化在 localStorage；`chat.*` 按会话去重，`codex/*` 只保留必要兼容去重。
- 按会话 resume 依赖服务端 Ring 过滤；若 `after` 落后于 Ring 最老条目，返回 `truncated=true` 并提示用户。

补充：当 `after>0` 时服务端会忽略 `tail` 参数；`tail` 仅在 `after==0` 作为“最新近况”返回段落。
