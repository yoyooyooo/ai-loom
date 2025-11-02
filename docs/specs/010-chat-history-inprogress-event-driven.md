# 规范：会话历史项“执行中”状态（纯事件范式）

状态：Draft

作者：前端/后端协作

更新日期：2025-10-30

## 背景与目标

- 背景：后端允许会话在后台持续运行（不强制随路由切换中断）。现有前端历史列表仅在“当前活跃会话且本地 generating=true”时显示项级转菊花，无法表达“非当前路由、但仍在执行”的会话状态。
- 目标：
  - 在不引入新的 REST 字段的前提下，以纯事件（WS 入环 `chat.*`）作为单一事实源，标注历史列表项是否“执行中”。
  - 刷新页面或从其他模块切入 `/chat` 时能正确衔接状态；随后保持实时更新且具备断线自愈与幂等。
  - 遵循 SSoT：前端仅消费平台层 `chat.*`；不依赖不入环事件（如 `chat.turn.started`、`chat.reasoning.delta`）。

不在此规范范围：
- REST `GET /api/chat/conversations` 增加 `inProgress` 字段（可作为备选方案 A，但本规范以纯事件为准）。
- 修改现有“历史列表数据分页/排序”逻辑。

## 术语与约束

- 入环/不入环：以 `docs/guide/codex-chat-ws-ssot.md` 为准。
  - 入环：`chat.message.*`、`chat.tool.*`、`chat.info.*`、`chat.turn.complete` 等。
  - 不入环：`chat.turn.started`、`chat.reasoning.delta|section_break`、`session.stats`、能力/认证类 `codex/*`。
- Turn-first 边界：首条内容隐式开启；`completed|failed|aborted|turn.complete` 收束（`docs/guide/codex-chat-turn-ssot.md`）。
- Resume：`events.resume({ topic:'chat', filter:{ conversationId }, after, tail })`；以 `eventId` 去重与推进（`docs/specs/004-chat-resume-multisession.md`）。

## 设计概述（纯事件范式）

实现要点：
1) 首帧衔接：进入 `/chat` 或刷新时，仅对“可视区会话项（包含当前活跃会话）”建立按会话订阅；rx-client 将自动执行按会话 Resume（带 `tail`），注入该会话的尾部入环事件用于归约当前状态。
2) 实时更新：订阅持续接收 `chat.*` 增量事件；按规则将 `convInProgress[cid]` 设为 true/false。
3) 断线自愈：WS 重连后自动重订阅并 Resume，重新归约状态；以 `convLast[cid]` 游标与 `eventId` 去重保证幂等。

### 状态归约规则（幂等）

- 进行中信号（任一到达置 true）：
  - `chat.message.delta`
  - `chat.tool.*.begin`
  - `chat.tool.*.output`
  - `chat.tool.*.end`（注意：最终以 turn 收束为准，该事件本身不代表完成）
- 收束信号（置 false）：
  - `chat.turn.complete`
  - 或在失败/中止序列后收到的 `chat.turn.complete`
- 特例：`chat.message.completed`
  - 会在规范实现中紧随 `chat.turn.complete` 收束（参考当前处理器逻辑）。如出现先到 `completed` 后到 `turn.complete` 的情况，最终以 `turn.complete` 为 false 判定。
- 不参与判定：`chat.turn.started`、`chat.reasoning.delta` 等不入环事件。
- 幂等：按 `(providerId|conversationId)` + `eventId` 单调推进，乱序/重复事件不回退状态。

### 可选事件：`chat.info.turn_state`（推荐）

为简化前端在首帧与断线后的状态重建，后端可在状态翻转时入环一条 `chat.info.turn_state`：

```
method: "chat.info.turn_state"
params: {
  eventId: number | string
  conversationId: string
  provider?: string
  turnSeq?: number
  inProgress: boolean
}
```

- 产生时机：从 false→true 或 true→false 的翻转点（含最终收束）。
- Resume：与其他入环事件一致；可作为前端归约的“定锚”事件，减少尾部事件遍历。
- 幂等：同样依赖 `eventId` 与 `turnSeq` 去重。

## 后端改动

- 位置（参考实现）：
  - `packages/rust/ailoom-server/src/services/codex/bridge.rs`：在 `map_notification_to_chat_events` 归一化 codex 事件处，识别进行中/收束事件；当检测到状态翻转时，额外 `broadcast(chat.info.turn_state)`（如采用推荐事件）。
  - `packages/rust/ailoom-server/src/ws/hub.rs::{broadcast, resume_after_chat, tail_chat}`：确保 `chat.info.turn_state` 入环并被 `events.resume` 正确返回。
  - `packages/rust/ailoom-server/src/ws/methods.rs::events.resume`：无特殊改动，仅保证按会话过滤和 `eventId` 序（已有）。
- 数据一致性：无需新增表结构；状态源自入环事件归约。若后续需要可在会话汇总表持久化 `lastTurnStatus/inProgress` 以支持 REST 方案 A（非本规范必要）。

## 前端改动

- 新增轻量状态映射：`convInProgress: Record<string, boolean>`（Zustand 或模块内局部状态皆可）。
- 订阅策略（HistoryList）：
  - 对“可视区”会话项按 `conversationId` 建立订阅：`ws.subscribeTopic$('chat', { conversationId: cid })`。
  - 订阅建立后，rx-client 自动 `resumeChat(cid)`，注入尾部事件；前端根据“状态归约规则”或 `chat.info.turn_state` 更新 `convInProgress[cid]`。
  - 离开可视区或组件卸载时取消订阅；“当前活跃会话”始终保持订阅。
- 菊花渲染规则：
  - `isInProgress = convInProgress[cid] || (activeId===cid && store.generating)`。
  - 渲染位沿用：`packages/web/src/features/codex-chat/components/history-list.tsx`（现有小菊花图标位置）。
- 自愈：
  - 断线后 `subscribeTopic$` 会自动重订阅并触发 `resumeChat(cid)`（`rx-client` 现有能力）。
  - 以 `convLast[cid]` 本地持久化游标避免重复处理（已由 `rx-client` 处理）。

### 文件级改动建议（最小集）

1) 新增前端 store/hook（示例）：`packages/web/src/features/codex-chat/stores/chat-conv-status.ts`
   - 暴露 `useConvInProgress(cid)` 与 `convStatusActions.applyEvent(method, params)`。
   - applyEvent 仅消费 `chat.*`（或优先消费 `chat.info.turn_state`）以更新 `convInProgress`。

2) 在 `HistoryList` 中：
   - 基于现有 `useInViewport`，对可视项调用 `convStatusActions.subscribe(cid)` / `unsubscribe(cid)`（内部用 `ws.subscribeTopic$`）。
   - 读取 `useConvInProgress(cid)` 决定是否显示菊花。

3) 活跃会话订阅：
   - 进入某会话路由后，确保对该 `conversationId` 有持续订阅（可复用现有会话订阅点）。

4) 保持与本地 generating 兼容：
   - 不改变 `store.generating` 语义；仅补充 `convInProgress` 以覆盖“非当前路由”的执行态。

## 时序与示例

1) 用户在会话 A 发送消息 → 服务端产生 `chat.message.delta`、`chat.tool.exec.begin` 等入环事件 → 前端收到后将 `convInProgress[A]=true`，历史项 A 显示菊花。
2) 用户切到会话 B（不自动中断 A）→ A 继续产生事件，订阅保持更新；历史项 A 仍显示菊花。
3) 会话 A 完成 → 服务端入环 `chat.turn.complete`（或 `chat.info.turn_state{inProgress:false}`）→ 前端将 `convInProgress[A]=false`，历史项 A 菊花消失。
4) 刷新页面 → 仅对屏内项（含活跃会话）按会话 Resume 注入尾部事件 → 归约首帧状态；随后继续增量。

## 边界与注意事项

- “Compact task completed” 文本属于 info 特例，不结束 Turn；仍需等待 `chat.turn.complete` 收束。
- 多 Provider：以 `(providerId|conversationId)` 作为订阅与 `convLast`/去重键，避免跨 Provider 混淆。
- 截断与重排：以 `eventId` 单调推进；乱序或重复事件不回退状态。
- 环容量与 tail：若 `tail` 不足以覆盖最近一次翻转，首帧可能需要多一帧增量才能纠正；推荐使用 `chat.info.turn_state` 降低该概率。

## 测试与验证

- 单测（前端）：
  - 归约函数：输入事件序列 → 验证 inProgress true/false 转换与幂等。
  - 订阅管理：可视区进出触发订阅/退订次数与资源回收。
- E2E：
  - “A 执行中 → 切到 B → A 仍菊花 → A 完成自动停止”。
  - 刷新页面后首帧状态正确，随后增量继续正确更新。
- 后端：
  - `events.resume` 按会话尾部含目标事件；若有 `turn_state`，验证其入环与 Resume 行为。

## 迁移计划

1) 后端（可选）：在状态翻转点广播 `chat.info.turn_state`（不影响既有 `chat.*` 流）。
2) 前端：落地 `convInProgress` 订阅与渲染；保持与现有 `generating` 兼容。
3) 文档：
  - `docs/guide/codex-chat-ws-ssot.md`：新增“会话级运行状态导出”小节，注明事件与 Resume 映射、去重/幂等。
  - `docs/guide/codex-chat-turn-ssot.md`：强调“状态=入环事件归约产物，最终以 turn.complete 收束”。

## 开发拆解（任务列表）

- 后端（可选）
  - [ ] 在 `services/codex/bridge.rs` 中落 `chat.info.turn_state`（翻转点）。
  - [ ] 校验 `ws/hub.rs`/`ws/methods.rs` 对该事件的入环与 Resume 行为。
- 前端
  - [ ] 新增 `convInProgress` store/hook 与事件归约逻辑。
  - [ ] HistoryList 按可视项建立/释放订阅；活跃会话常驻订阅。
  - [ ] 历史项渲染使用 `convInProgress[cid] || (activeId===cid && generating)`。
  - [ ] E2E 覆盖执行中切换/刷新首帧/断线重连。
- 文档
  - [ ] 按上述指南补齐 `docs/guide/*` 对应章节（在提 PR 时链接本规范）。

