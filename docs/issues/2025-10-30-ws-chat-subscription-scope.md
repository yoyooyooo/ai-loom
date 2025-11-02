# WS：Chat 事件推送范围（全局关键状态监听 vs 路由内订阅）

场景与目标：当前前端未切到聊天页面时仍可能收到 `chat.*` 事件（虽不渲染，但占用带宽/解析开销）。希望：
- 全局长期监听“关键状态变更”（如任务结束/失败/中止/收尾）。
- 其他聊天细粒度事件仅在进入聊天路由时订阅与处理。
- 兼顾 SSoT/Resume 语义，不引入漏帧或乱序导致的状态错乱。

## 现状（实现核对）

- 无条件直通（不过滤）：为防订阅时序抖动导致漏发，后端对 `session.stats`、`file.changed`、`tree.changed`、`session.resync` 直通给所有连接。
  - docs/guide/ws-overview.md:188
- `chat.*` 现也在连接层被“无条件放行”：即使未订阅 `topic:'chat'`，`chat.*` 仍会转发到该连接。
  - packages/rust/ailoom-server/src/ws/conn.rs:261
- 会话级 Resume：`events.resume({ topic:'chat', filter:{ conversationId }, after, tail })` 仅返回该会话的增量，`after>0` 时忽略 `tail`。
  - docs/guide/codex-chat-ws-ssot.md:12
  - packages/rust/ailoom-server/src/ws/methods.rs:112
  - packages/rust/ailoom-server/src/ws/hub.rs:153
- 前端订阅挂载点：仅聊天面板挂载 `subscribeChatEvents()`，并按会话切换重建订阅。
  - packages/web/src/features/codex-chat/components/chat-panel.tsx:69
  - packages/web/src/features/codex-chat/services/ws.ts（`subscribeTopic$('chat', ...)`）
- 去重与断点：前端对 `chat.*` 维持每会话 `convLast[cid]` 游标并持久化，保证幂等与断点恢复；非聊天页也不会渲染。
  - packages/web/src/lib/ws/rx-client.ts:236

## 问题陈述
- 未在聊天页时，连接仍会收到 `chat.*` 事件（不渲染但占用 WS 吞吐和解析）。
- 期望“关键状态变更”全局感知，其余细节仅在聊天页订阅，降低闲时噪声与压力。

## 目标
- 全局持续监听最小集合的关键事件：
  - 候选：`chat.turn.complete`、`chat.message.completed|failed|aborted`（可按实际需要再收敛）。
- 其余 `chat.*` 仅在存在 `topic:'chat'` 订阅且（可选）带上 `conversationId` 时才推送。
- 不破坏：按会话 Resume、去重游标、Turn-first SSoT 边界与结束收束语义。

## 方案 A（服务端筛选，推荐渐进 + 开关）
- 改动点：调整连接层转发白名单逻辑，将 `chat.*` 从“无条件允许”改为：
  - 仅当存在 `topic:'chat'` 的订阅匹配（可选按 `conversationId/providerId`）时转发；
  - 或事件属于“关键白名单”（如上候选集合）时仍无条件直通；
  - 仍保持 `session.stats/file.changed/tree.changed/session.resync` 无条件直通。
- 启用方式：新增开关（建议）`AILOOM_WS_CHAT_REQUIRE_SUB=1`，默认保持现状；便于灰度与回滚。
- 影响面：
  - 订阅时序：订阅建立前的 `chat.*` 细节不会下发，但页面订阅后可通过 `events.resume(topic:'chat', filter:{conversationId}, after/tail)` 补齐。
  - 压力：显著降低未进入聊天页时的 `chat.*` 推送量。
- 风险/缓解：
  - 切页瞬间可能错过路由切换期间的细节事件 → 订阅建立时附带 `tail`（after==0）或使用 `convLast` 做增量补偿。

## 方案 B（前端仅全局监听“关键事件”，维持后端直通）
- 不改后端；在应用根处挂全局轻订阅，仅处理关键事件用于全局 UI（如通知/角标）。
- 优点：零服务端改动，落地快。
- 局限：WS 侧流量不降，仍会把所有 `chat.*` 发到未使用页面的连接；仅减少前端处理负担。

## 推荐路线（分阶段）
1) 文档记录 + 指标观察（本议题）：观察 `broadcasts/noReceiver/events/s` 与页面未在聊天路由时的事件量。
2) 增加服务端开关 `AILOOM_WS_CHAT_REQUIRE_SUB`，默认关闭；开启后仅直通“关键白名单”。
3) 前端订阅保证：聊天面板尽早绑定 `conversationId`，避免 `{}` 订阅导致“全会话”泛滥；订阅时携带 `tail` 做补偿。

## 验收与验证
- 未在聊天页：
  - 仅见 `session.stats/file.changed/tree.changed/session.resync` 与关键 `chat.*`（若开启方案 A）。
  - `events/s` 明显下降；`broadcasts.noReceiver` 不异常增长。
- 聊天页：
  - 切入后通过 `events.resume({topic:'chat', filter:{conversationId}, after, tail:64})` 补齐；无漏帧、无重复；`convLast[cid]` 正确推进。
- 断线/自愈：Supervisor 触发 `session.resync` 后重连 + resume 行为与当前一致。

## 关联规范/代码
- 指南：
  - docs/guide/ws-overview.md:188（无条件直通）
  - docs/guide/codex-chat-ws-ssot.md:11-13（入环/按会话 Resume）
- 服务端：
  - packages/rust/ailoom-server/src/ws/conn.rs:257-266（无条件允许 `chat.*`）
  - packages/rust/ailoom-server/src/ws/methods.rs:112（`events.resume` 分支与 `topic:'chat'` 过滤）
  - packages/rust/ailoom-server/src/ws/hub.rs:153-186（`resume_after_chat/tail_chat`）
- 前端：
  - packages/web/src/features/codex-chat/components/chat-panel.tsx:69（挂载聊天订阅）
  - packages/web/src/features/codex-chat/services/ws.ts（RxJS 管道与订阅）
  - packages/web/src/features/codex-chat/services/processors/index.ts（处理器入口）
  - packages/web/src/lib/ws/rx-client.ts:236（`convLast[cid]` 去重/断点）

## TODO / 后续
- 评审“关键白名单”精确范围（是否仅 `turn.complete` 与 `message.completed|failed|aborted`）。
- 评审并落地 `AILOOM_WS_CHAT_REQUIRE_SUB` 开关与默认值。
- 若采用方案 A：为订阅建立时序补偿增设最小 `tail` 与观测指标（避免漏帧）。
- 结合 `docs/guide/codex-chat-turn-ssot.md` 再次逐项自检边界/幂等与恢复一致性。
