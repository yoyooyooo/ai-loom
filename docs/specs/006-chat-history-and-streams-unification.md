# 006 — Chat 历史回放与实时统一化（WS/Resume 一致、Turn-first 保持）

> 目的：消除“Resume 与实时消息两套链路”的分裂，统一为平台层 `chat.*` 事件的单一路径；由服务端完成归一化与入环（Ring），客户端只消费 `chat.*` 并通过 `events.resume` 做增量补偿。Turn-first 渲染与 UI 结构保持不变。

## 背景与目标对齐

- 当前行为（2025）
  - 实时：服务端在 `bridge.rs::map_notification_to_chat_events` 将所有 `codex/event/*` 归一化为平台层 `chat.*` 并写入 Hub ring；前端直接订阅 `chat.*`。
  - 恢复（HTTP）：rollout/initialMessages 依旧返回 Turn 骨架，增量补偿改由 `events.resume(topic:'chat', filter:{ conversationId })` 统一提供。
  - Hub ring：所有参与渲染的 `chat.*` 写入 ring 并携带 `eventId` + `conversationId`，支持按会话补偿；`chat.reasoning.delta` 等瞬时事件仍通过 `broadcast_ephemeral` 下发。
  - 多会话：前端维护 `convLast[cid]` 并在会话切换或重连时调用 `resumeChat(cid)`；服务端过滤确保游标隔离。
- 设计目标：保持 Turn-first 渲染与数据结构不变，只在事件来源与补偿路径统一，降低前后端重复实现成本。

## 设计目标

- 单一路径：WS 与 Resume 均产出同构的“平台层 `chat.*` 事件”，Turn-first reducer 只保留一套逻辑。
- 可靠补偿：所有 `chat.*` 入 Ring，统一分配 `eventId/ts`；`events.resume` 也能补偿 `chat.*`，避免刷新/重连丢帧。
- 会话隔离：支持按会话 Resume（`{ topic:'chat', filter:{ conversationId } }`），为并行会话预留断点游标。
- 渲染保持：Turn-first + 折叠工具/推理，UI 数据结构不变；仅来源统一、边界一致。

## 总体方案（History + Stream 合一）

1) 服务端负责归一化与入环
   - 将 Codex 的 `codex/event/*` 映射为平台层 `chat.*`（含 `conversationId`），并通过 Hub 写入 ring（由 Hub 自动注入 `eventId/ts`）。
   - 非业务类事件（认证、费率等）仍以 `codex/*` 广播，使用 `broadcast_ephemeral` 不入 ring（不影响 resume 游标）。
2) 事件环（Ring）承载所有可补偿业务事件
   - `file.* / tree.* / annotations.* / chat.*` 入 ring；`tree.changed` 仍低优先级，可被优先淘汰。
   - `EventRecord` 增加 `conversation_id`（从 `params.conversationId` 提取），用于按会话 resume 过滤。
3) 按会话 Resume
   - 扩展 `events.resume` 参数：`{ after?: number, tail?: number, topic?: 'chat'|'file'|'tree'|'annotations', filter?: { conversationId?: string } }`。
   - 当 `topic==='chat'` 且存在 `filter.conversationId` 时，仅返回该会话的 `chat.*` 事件（带历史尾部或增量）。
4) 客户端消费统一化事件
   - `rx-client` 对 `chat.*` 同样推进 `lastEventId`（或 `convLast[conversationId]`）。
   - 重连时对活跃会话调用 `events.resume({ after, topic:'chat', filter:{ conversationId }, tail:128 })`，按顺序回放，然后继续订阅直播。
   - Turn-first reducer 与组件保持不变。

## 平台层事件协议（精简版）

- 文本：`chat.message.delta|completed|failed|aborted`
- 推理：`chat.reasoning.delta|end|section_break`
- 工具：`chat.tool.exec.begin|output|end`、`chat.tool.patch.begin|end`、`chat.tool.mcp.begin|end`
- 回合：`chat.turn.started`（遇首条内容可隐式开启）、`chat.turn.complete`
- 会话：`chat.session.new|resumed|history`
- 元信息：服务端注入 `ts`、`eventId`；Resume 时可增补 `turnSeq`（可选）
- 特例：文本为 `Compact task completed` → 记为 info 步骤插入当前 Turn，不结束/新建 Turn。

> 详尽边界/优先级/特例以 `docs/guide/codex-chat-turn-ssot.md` 为权威。

## 最终决策（拍板结论）

- 回放路径：HTTP resume 仅负责“触发/建联 + 返回稳定历史骨架（history）”；所有“可见增量回放”与直播统一走 WS（`events.resume` + 订阅）。
- 入环范围（参与渲染的事件）
  - 入环：`chat.message.delta|completed|failed|aborted`、`chat.reasoning.end`、`chat.tool.exec.*`、`chat.tool.patch.*`、`chat.tool.mcp.*`。
  - 不入环（ephemeral）：`session.stats`、认证/配额类 `codex/*`、`chat.turn.started`、`chat.reasoning.delta`。这些仅直播，不做增量补偿。
- 多会话并发：服务端支持 `{ topic:'chat', filter:{ conversationId } }` 的按会话 resume；前端维护每会话断点 `convLast[cid]` 并持久化。
- eventId 与去重：
  - 服务端：所有入环事件自动注入 `eventId/ts`（全局自增）；`broadcast_ephemeral` 不注入 `eventId`、不入环。
  - 客户端：按会话 `convLast[cid]` 去重与推进；`eventId <= convLast[cid]` 的事件直接忽略。
- Ring 容量：单位为“事件条数”（而非字节）。默认 4096（可通过 `AILOOM_WS_RING_CAP` 配置）。
- tail 语义：`after == 0` 时允许 `tail`（默认 128）返回近况；`after > 0` 时忽略 `tail`，只返回 `eventId > after` 的增量。

## 事件入环清单

- 文本（入环）
  - `chat.message.delta`（用于补齐刷新窗口内的文本片段）
  - `chat.message.completed|failed|aborted`
- 推理（部分入环）
  - 入环：`chat.reasoning.end`（总结进入时间线）
  - 不入环：`chat.reasoning.delta`（仅实时，不做补偿）
- 工具（入环）
  - `chat.tool.exec.begin|output|end`
  - `chat.tool.patch.begin|end`
  - `chat.tool.mcp.begin|end`
- 回合/会话（按需）
  - 不入环：`chat.turn.started`（遇首个内容事件隐式开启）
  - 可入环：`chat.turn.complete`（若已通过 completed/failed/aborted 触发收束，也可仅直播，不做硬性要求）
  - 不入环：`chat.session.new|resumed|history`（history 由 HTTP resume 返回；也可用直播一次性广播作为首帧，但不入环）

备注：`Compact task completed` 文本作为 info 步骤插入当前 Turn（不结束/不新建 Turn）。

## 回放与重连流程（WS-only 增量补偿）

1) 首次进入/刷新会话 `<cid>`：
   - 订阅：`subscribeTopic('chat',{ conversationId: <cid> })`
   - 增量回放：调用 `events.resume({ after: convLast[<cid>] || 0, topic: 'chat', filter: { conversationId: <cid> }, tail: 128 })`
   - 处理：对返回的 `events[]` 逐条派发到统一处理器（与直播一致），并用 `eventId` 去重
   - 直播：继续消费订阅的直播事件

2) 断线自愈：
   - 服务端 `supervisor` 比较 `hub.lastEventId` 与该连接“最后成功写出”的 `eventId`，落后超阈值则下发 `session.resync` 并主动断开
   - 客户端重连后按步骤 1 重复（确保空窗期补齐）

伪代码（前端）：

```ts
const cid = currentConversation()
ws.subscribeTopic$('chat', { conversationId: cid })
const after = convLast[cid] || 0
const res = await ws.call('events.resume', { after, topic: 'chat', filter: { conversationId: cid }, tail: 128 })
for (const ev of res.events) emit(ev) // 与直播一致处理
// 直播：onmessage(ev) { if (ev.eventId > convLast[cid]) { process(ev); convLast[cid] = ev.eventId } }
```

## 去重与断点职责

- 服务端
  - `hub.broadcast`：自动注入 `eventId/ts` 并入环；`EventRecord` 记录 `conversation_id`
  - `events.resume`：按 `{ topic, filter, after }` 返回 backlog；支持 `tail`（首帧近况）
  - `writer/supervisor`：以“该连接最后成功写出的业务事件 `eventId`”为准触发 `session.resync` 自愈
- 客户端
  - `convLast[cid]`：每会话断点，持久化在 localStorage（建议 key：`ailoom.chat.convLast`）
  - 去重：`if (ev.eventId <= convLast[cid]) skip`；`convLast[cid] = max(convLast[cid], ev.eventId)`
  - 顺序：事件按接收顺序处理，边界由 `completed|failed|aborted|turn.complete` 统一收束

示例结构：

```json
{
  "convLast": { "<cid-1>": 12347, "<cid-2>": 90210 }
}
```

## 多会话并发（同一进程）

- 订阅隔离：`subscribeTopic('chat', { conversationId: <cid> })`；WS 层已支持按会话过滤
- 断点隔离：每会话维护 `convLast[<cid>]`；重连后分别执行 `events.resume(chat,<cid>)`
- Ring 过滤：`events.resume` 在服务端按 `conversation_id` 过滤返回

## 与 Codex Rollout 的关系

- 深历史：HTTP resume 读取 `~/.codex/sessions/.../rollout-*.jsonl`，由服务端归一化为 `history`（稳定骨架与终结项）。
- 增量：所有“可见增量”统一走 WS（ring + `events.resume`），不再由 HTTP 返回。
- “半包 delta”问题：刷新/重连时正在流动的 delta 片段被 ring 捕获；前端通过 `events.resume(chat,<cid>)` 拉取补齐，再以 `eventId` 去重与合并。

## 配置与默认值

- `AILOOM_WS_RING_CAP`：ring 容量（事件条数），默认 4096
- `AILOOM_WS_DEDUP_MS`：`file.changed` 等短窗去重，默认 200ms（不影响 `eventId` 注入）
- `events.resume.tail`：默认 128（仅在 `after==0` 时生效）
- 其他现有开关：参考 `docs/guide/ws-overview.md`（`VITE_WS_DEBUG*` / `AILOOM_WS_EAGER_SAVE_ECHO` 等）

## 架构拆分与骨架（后端）

层次与职责
- Provider 归一化层：将 Codex `codex/event/*` 规范化为平台层 `chat.*`，附带 `conversationId`。
  - 入口：`packages/rust/ailoom-server/src/services/codex/client.rs:on_notification`
  - 映射：`packages/rust/ailoom-server/src/services/codex/bridge.rs`（新增 `map_notification_to_chat_events`）
  - 输出：对每条 `chat.*` 调用 `hub.broadcast(method, params)`（入环）；认证/配额类 `codex/*` 用 `hub.broadcast_ephemeral`（不入环）。
- WS 中枢层（Hub/Ring）：统一注入 `eventId/ts`、保存 ring、提供 `resume_after` 与按会话过滤。
  - 文件：`packages/rust/ailoom-server/src/ws/hub.rs`
  - 关键：`EventRecord { id, method, params, conversation_id }`
- WS 会话层（Conn）：单写者/分流/自愈；订阅过滤按 `{ topic, filter }`；监督 `eventId` 落后触发 resync。
  - 文件：`packages/rust/ailoom-server/src/ws/conn.rs`
- WS 方法层：`events.resume` 支持 `{ topic, filter, after|tail }`；`session.info` 等。
  - 文件：`packages/rust/ailoom-server/src/ws/methods.rs`
- HTTP Resume：触发/建联，返回 `history`（可选，`events` 字段仅保留兼容且默认为空）并以 `broadcast_ephemeral` 广播 `chat.session.resumed|history`（不入环）。
  - 文件：`packages/rust/ailoom-server/src/routes/chat/resume/handler.rs`

骨架伪代码
```rust
// client.rs
async fn on_notification(&self, _peer, _raw, n: JSONRPCNotification) -> Result<bool> {
  if let Some(hub) = self.hub.lock().unwrap().clone() {
    if n.method.starts_with("codex/event/") {
      for ev in map_notification_to_chat_events(&n) { // -> Vec<BroadcastEvent>
        // ev.params 必须包含 conversationId
        hub.broadcast(ev.method, ev.params);
      }
      return Ok(false);
    }
    // 能力/认证类：不入环
    if matches!(n.method.as_str(), "codex/sessionConfigured"|"codex/authStatusChange"|"codex/account/rateLimits/updated") {
      for ev in map_notification_ephemeral(&n) { hub.broadcast_ephemeral(ev.method, ev.params); }
    }
  }
  Ok(false)
}

// hub.rs（入环与按会话 resume）
pub fn broadcast(&self, method: String, mut params: Value) {
  let id = self.next_id.fetch_add(1, Relaxed);
  let ts = now_rfc3339();
  // 注入 ts/eventId
  if let Some(o) = params.as_object_mut() {
    o.entry("ts").or_insert(json!(ts));
    o.entry("eventId").or_insert(json!(id));
  }
  let conversation_id = params.get("conversationId").and_then(|v| v.as_str()).map(|s| s.to_string());
  push_into_ring(EventRecord { id, method: method.clone(), params: params.clone(), conversation_id });
  self.tx.send(Event { method, params }).ok();
}

pub fn resume_after_chat(&self, after: u64, cid: &str) -> (Vec<EventRecord>, bool) {
  let ring = self.ring.lock().unwrap();
  let oldest = ring.front().map(|e| e.id).unwrap_or(0);
  let truncated = after != 0 && after < oldest;
  let mut out = vec![];
  for e in ring.iter() {
    if e.id > after && e.conversation_id.as_deref() == Some(cid) { out.push(e.clone()); }
  }
  (out, truncated)
}

// methods.rs（events.resume）
match (topic, filter.conversationId) {
  (Some("chat"), Some(cid)) => hub.resume_after_chat(after, &cid),
  _ => hub.resume_after(after),
}
```

约束与约定
- 所有参与渲染且需要短窗补偿的 `chat.*` 必须入环；`chat.reasoning.delta`/`chat.turn.started` 不入环。
- `conversationId` 必须出现在所有 `chat.*` 的 `params`，以支持按会话 resume 与订阅过滤。

## 架构拆分与骨架（前端）

层次与职责
- WS 客户端（`packages/web/src/lib/ws/rx-client.ts`）
  - 连接/重连、订阅管理、`events.resume` 调用与结果分发
  - 断点存储：`convLast: Record<string /*cid*/, number /*eventId*/>`（localStorage 持久化）
  - 去重：若 `eventId <= convLast[cid]` 则丢弃
  - API：`subscribeTopic$('chat', { conversationId })`、`call('events.resume', ...)`
- Chat 事件服务（`packages/web/src/features/codex-chat/services/ws.ts`）
  - 订阅当前会话、守卫不同会话事件（忽略非当前 cid）
  - 首帧：按需应用 `chat.session.history`（仅当本地没有 turns）
  - 统一处理器：`createProcessChatEvent`（只消费 `chat.*`，不再依赖前端 normalize）
- Turn-first Store（`packages/web/src/features/codex-chat/stores/*`）
  - 统一 reducer：事件→动作（delta/complete/failed/aborted、tool begin/output/end、reasoning.end、turn.complete）
  - Index：`toolIndex[callId] → stepId` 聚合工具输出

骨架伪代码
```ts
// rx-client.ts
class WsRxClient {
  private convLast: Record<string, number> = loadFromLocalStorage()
  subscribeTopic$(topic: 'chat', filter: { conversationId?: string }) { /* 订阅与自动重订阅 */ }
  async resumeChat(cid: string) {
    const after = this.convLast[cid] || 0
    const res = await this.call('events.resume', { after, topic: 'chat', filter: { conversationId: cid }, tail: 128 })
    for (const ev of res.events) this.eventsSubject.next({ method: ev.method, params: ev.params })
  }
  private onMessage(v: { method: string, params: any }) {
    if (v.method.startsWith('chat.')) {
      const cid = v.params?.conversationId
      const id = parseEventId(v.params)
      if (cid && id && id <= (this.convLast[cid] || 0)) return // 去重
      if (cid && id) this.convLast[cid] = id
      this.eventsSubject.next(v)
    }
  }
}

// ws.ts（会话变更与首帧）
const cid = useChatTurnStore.getState().conversationId
let sub = ws.subscribeTopic$('chat', { conversationId: cid }).subscribe(handle)
await ws.resumeChat(cid)
// route 会话变更：
sub.unsubscribe(); sub = ws.subscribeTopic$('chat', { conversationId: cid }).subscribe(handle); await ws.resumeChat(cid)

// 统一处理器入口（只消费 chat.*）
function handle({ method, params }) {
  if (!guardConversation(params.conversationId)) return
  processChatEvent(method, params) // 调用 createProcessChatEvent 返回的处理函数
}
```

目录与命名
- 服务端：保持按模块分层（services/codex/*、ws/*、routes/chat/*），新增映射函数置于 `services/codex/bridge.rs`。
- 前端：遵循 slice-first（stores 拆分 core/snapshot/slice）、kebab-case 文件名、`@` 别名导入（见 `docs/frontend-architecture.md`）。

## 实施与验收补充

- 实施顺序（不变）：Phase A（服务端归一化 + 按会话 resume）→ Phase B（前端 convLast + chat.* resume）→ Phase C（移除前端 normalize 双实现）
- 用例补充：
  - 并行 A/B 两会话生成；刷新后分别 resume；时间线一致、互不串台
  - 刷新时处于 delta；刷新后 `events.resume` 补齐；无重复/错序
  - ring 截断：`truncated=true` 时轻提示；最终回答/Reasoning 与历史一致

## 测试策略与用例清单（前后端）

总体策略
- 单元优先、集成补足：服务端核心模块（Hub/Ring、events.resume 过滤、映射归一化）与前端核心模块（rx-client、chat-turn reducer）均提供细粒度单测；对 WS 路径用轻量集成测试验证握手/订阅/重播路径。
- 场景驱动：覆盖“刷新中断 delta”“多会话并行”“ring 截断”“ephemeral 不入环”等关键边界。
- 既有测试整合：更新或替换旧断言，统一以 `chat.*` 为准；保留必要的 codex/* 能力类事件断言，但不参与 resume。

服务端（Rust）
- Hub/Ring（packages/rust/ailoom-server/src/ws/hub.rs）
  - 新增：`ring_insert_injects_event_id_and_ts`（验证 `eventId/ts` 自动注入）
  - 新增：`resume_after_returns_gt_after_only`（验证增量过滤）
  - 新增：`resume_after_chat_filters_by_conversation_id`（按会话过滤返回，仅该会话事件）
  - 新增：`tail_returns_latest_n_events`（验证 tail 近况）
  - 新增：`ephemeral_not_in_ring_and_no_event_id`（验证不入环的事件不含 `eventId`）

- events.resume（packages/rust/ailoom-server/src/ws/methods.rs）
  - 新增：`events_resume_supports_topic_and_filter_chat`（topic=chat + filter.conversationId 生效）
  - 新增：`events_resume_ignores_tail_when_after_gt_zero`（after>0 时忽略 tail）
  - 更新：原有 resume 测试扩展覆盖 `chat.*`

- Codex 归一化（packages/rust/ailoom-server/src/services/codex/bridge.rs & client.rs）
  - 新增：`map_notification_to_chat_events_basic_mapping`（codex/event/* → chat.* 的方法名/字段映射）
  - 新增：`mapping_preserves_conversation_id`（确保 `conversationId` 透传）
  - 新增：`ephemeral_codex_events_not_in_ring`（认证/配额类事件走 `broadcast_ephemeral`）

- Resume 回放（packages/rust/ailoom-server/src/routes/chat/resume/event_accumulator.rs / handler.rs）
  - 既有用例继续有效（history/turnSeq/工具聚合）；补充断言服务端广播 `chat.session.resumed|history` 的存在且不入环。

- WS 集成（packages/rust/ailoom-server/tests/*）
  - 更新/新增：
    - `ws_resume_chat_topic_filter.rs`：起服务 → 订阅 chat/<cid> → 插入混合会话事件 → `events.resume(chat,<cid>)` 仅返回该会话增量
    - `ws_broadcast_event_id_monotonic.rs`：验证 `eventId` 单调递增与客户端去重基础
    - `ws_ephemeral_not_resume.rs`：`session.stats` 不出现在 resume 响应

前端（TypeScript/Vitest）
- rx-client（packages/web/src/lib/ws/rx-client.test.ts）
  - 新增：`chat_events_update_conv_last_and_dedupe`（收到 `chat.*` 更新 `convLast[cid]`，相同/过期 `eventId` 丢弃）
  - 新增：`try_resume_calls_chat_topic_with_filter`（`events.resume({ topic:'chat', filter:{ conversationId } })` 正确调用且只派发 chat.*）
  - 新增：`tail_semantics_when_after_zero`（after==0 使用 tail；after>0 忽略）
  - 保留/更新：`codex/event` 去重逻辑保留到迁移完成前的兼容旗标测试。

- chat 订阅与守卫（packages/web/src/features/codex-chat/services/ws.ts）
  - 新增：`guard_conversation_only_process_matching_cid`（仅处理匹配会话的事件）
  - 新增：`session_history_applied_only_when_no_turns`（无本地 turns 时才吃一次性 history）

- Turn-first reducer（packages/web/src/features/codex-chat/stores/**）
  - 新增：`delta_then_completed_closes_turn`（delta→completed→completeTurn，一致收束）
  - 新增：`compact_done_as_info_step`（“Compact task completed”渲染为 info 步骤，不结束 Turn）
  - 新增：`tool_steps_aggregate_by_call_id`（begin/output/end 聚合到同一步骤）
  - 新增：`reasoning_end_enters_timeline_delta_not`（end 入时间线，delta 不入）

测试数据与工具
- 事件构造器：提供 `makeChatEvent(method, params)` 帮助在前后端测试中快速构造标准化事件（含/不含 `eventId`）。
- 双会话样本：`cidA/cidB` 交错事件序列，覆盖 resume 过滤与 convLast 独立推进。

整合与门槛
- 旧用例梳理：`ws_handshake.rs`、`ws_rpc_and_broadcast.rs`、`ws_resume.rs`、`rx-client.test.ts` 统一断言口径为 `chat.*`；移除对前端 normalize 结果的强依赖。
- 覆盖率：不设硬门槛，确保关键路径“ring/事件注入/resume 过滤/rx-client 去重/reducer 边界”均有用例。

## 服务端改造（落地点）

- 归一化到 `chat.*`
  - 新增映射：将 `codex/event/*` → `chat.*`（含 `conversationId`）；大部分映射可复用 Resume 的归一化逻辑：
    - 参考：`packages/rust/ailoom-server/src/routes/chat/resume/event_accumulator.rs`
    - 挂载点：`packages/rust/ailoom-server/src/services/codex/client.rs` 的 `on_notification`，将现有 `bridge::map_notification(...)` 扩展为 `map_notification_to_chat_events(...)` 并 `hub.broadcast(...)`。
  - 能力/认证类：`codex/sessionConfigured`、`codex/authStatusChange`、`codex/account/rateLimits/updated` 仍以 `codex/*` 形式 `broadcast_ephemeral`（不入 ring）。
- Ring 扩展与按会话 resume
  - `packages/rust/ailoom-server/src/ws/hub.rs`
    - `EventRecord` 增加 `conversation_id: Option<String>`；`broadcast` 从 `params.conversationId` 提取写入。
    - 新增 `resume_after_chat(after, conversation_id)` 或通用 `resume_after_filtered`。
  - `packages/rust/ailoom-server/src/ws/methods.rs`
    - `events.resume` 支持 `{ topic, filter }`，当 `topic==='chat' && filter.conversationId` 时按会话过滤返回。
- Resume HTTP 端点（保持）
  - `packages/rust/ailoom-server/src/routes/chat/resume/handler.rs`：继续返回 `history`（`events` 字段仅 legacy）；成功后通过 `broadcast_ephemeral` 推送 `chat.session.resumed` 与可选 `chat.session.history`。

## 客户端改造（落地点）

- 统一消费 `chat.*`
  - `packages/web/src/features/codex-chat/services/ws.ts`：始终通过 `subscribeTopic('chat', { conversationId })` 接收聊天事件，仅保留能力类 `codex/*`。
  - `packages/web/src/features/codex-chat/services/delta-streams.ts`：RxJS 微批改为监听 `chat.message.delta` / `chat.reasoning.delta`，首帧缺失时仍会隐式开启 turn。
- Resume 补偿 `chat.*`
  - `packages/web/src/lib/ws/rx-client.ts`
    - `onMessage`：为 `chat.*` 维护 `convLast` 去重（localStorage 持久化）并更新 `lastEventId`；`codex/event/*` 仅保留最小兼容去重。
    - `resumeChat(cid)`：封装 `events.resume({ after: convLast[cid], topic:'chat', filter:{ conversationId: cid }, tail:128 })`，统一在重连或会话切换时补偿。
    - `tryResume()`：继续处理文件/树/批注增量，未来可按需迁移到 topic 模式。
- HTTP resume 结果
  - `packages/web/src/features/codex-chat/stores/chat-resume.ts`：只消费 `history` 骨架；`events` 字段保留兼容但默认空，增量交由 WS。
- Turn-first 渲染：保持不变（仅来源统一），参考 `docs/guide/codex-chat-turn-ssot.md`。

## API 示例

- 请求（按会话增量恢复）：
```json
{"jsonrpc":"2.0","id":1,"method":"events.resume","params":{
  "after": 12345,
  "topic": "chat",
  "filter": {"conversationId": "<cid>"},
  "tail": 128
}}
```
- 响应：
```json
{
  "jsonrpc":"2.0",
  "id":1,
  "result":{
    "events":[
      {"jsonrpc":"2.0","method":"chat.tool.exec.begin","params":{ "conversationId":"<cid>", "eventId":"12346", "...":"..." }},
      {"jsonrpc":"2.0","method":"chat.message.delta","params":{ "conversationId":"<cid>", "eventId":"12347", "delta":"..." }}
    ],
    "truncated": false
  }
}
```

## 实现里程碑（已完成）

- 服务端：`map_notification_to_chat_events` 接管实时归一化，Hub ring 记录 `conversation_id` 并提供 `resume_after_chat`/`tail_chat`。
- 客户端：`ws.ts` 仅消费 `chat.*`，Rx pipelines 转为监听 `chat.message.delta`/`chat.reasoning.delta`；`rx-client` 维护 `convLast` 并封装 `resumeChat()`。
- 收尾：删除遗留的 `ws-normalize.ts` 前端归一化实现，文档及测试均以服务端归一化为准。

## 验收清单

- 刷新处于 delta：刷新 → WS 连接 → `events.resume(chat,<cid>)` → 文本/推理/工具增量连续无断裂。
- 回合边界：`completed|failed|aborted|turn.complete` 一致触发收束；`Compact task completed` 仅作为 info 步骤，不结束 Turn。
- 多会话（预留）：A/B 并发生成；分别订阅/分别 resume，不串台。
- 自愈：模拟慢写或丢包，触发 `session.resync` + close-first；重连后 resume 正确补齐。
- 截断：`truncated=true` 时 UI 轻提示；最终回答/Reasoning 与历史一致。

## 风险与对策

- Ring 容量：建议提升 `ring_cap`（≥4096）覆盖长任务增量；树事件维持低优先级可丢弃。
- 归一化迁移期：前端 normalize 与服务端归一化短期并存，需保持映射表一致（以服务端为准，前端仅兜底）。
- 多 Provider：`chat.*` 为平台层协议，Codex/MCP/其他执行器统一映射；新增 Provider 仅需提供“原始事件 → chat.*”映射模块。

## 实施指引（文件路径）

- 服务端
  - `packages/rust/ailoom-server/src/services/codex/client.rs`
  - `packages/rust/ailoom-server/src/services/codex/bridge.rs`
  - `packages/rust/ailoom-server/src/ws/hub.rs`
  - `packages/rust/ailoom-server/src/ws/methods.rs`
  - `packages/rust/ailoom-server/src/routes/chat/resume/event_accumulator.rs`
- 客户端
  - `packages/web/src/lib/ws/rx-client.ts`
  - `packages/web/src/features/codex-chat/services/ws.ts`

> 关联规范：`docs/guide/codex-chat-turn-ssot.md`（Turn-first 边界/映射/特例的权威定义）。
