# 007 — 多 Agent 编排（Orchestrator）方案总览（基于 Codex、WS 归一化、Turn-first 保持）

本文为“在现有 Codex App Server + 平台层 chat.* 归一化 + Turn-first 渲染”基础上，引入多 Agent 协作能力的方案总览。目标是在不引入外部编排平台的前提下，快速落地“父会话触发子会话、并行协作、双向通信、可恢复”的能力，并保持现有 SSoT 与 006 历史统一化的约束不变。

## 目标与原则

- 多 Agent：在同一项目/上下文中创建多个“Agent 实例”（专职/通用），可串行或并行协作。
- 协作闭环：Agent 能在执行过程中“主动提出协作请求”（spawn/send/stop/report），平台执行并可视化协作态势。
- 平台统一：所有可见增量仍以平台层 `chat.*` 广播；Turn-first（SSoT）保持不变；WS 与 Resume 统一。
- 增量落地：优先采用“有界指令块 + 轻编排（Orchestrator）”方案；成熟后再评估 MCP 工具化。
- 低耦合：不强依赖 plan_update 的原生语义；指令块完全由平台解析与执行，避免与模型内置工具耦合。

## 适配现状（已具备能力）

- Codex JSON-RPC：
  - 监听：`addConversationListener{ conversationId }` → 推送 `codex/event/*`。
  - 新建/恢复：`newConversation`、`resumeConversation`。
  - 交互：`sendUserMessage`、`interruptConversation`。
- 归一化与 WS：
  - 归一化：`codex/event/*` → 平台层 `chat.*`（附 `conversationId`）。
  - 已完成：为所有 `chat.*` 注入 `provider: 'codex'`；Ring 记录 `provider_id`；`events.resume` 支持 `filter: { conversationId, providerId? }`；前端 `convLast` 以 `provider|conversationId` 作为去重游标键。
  - Turn-first：渲染/边界/幂等保持（详见 `docs/guide/codex-chat-turn-ssot.md`）。

## 本方案组成

- 事件规范（event-spec.md）
  - 保持现有 `chat.*`，新增信息类事件：`chat.agent.spawned`、`chat.agent.report`、（可选）`chat.agent.status`。
  - 保留 `provider` 字段；后续按需增加 `agentId` 字段（不破坏向后兼容）。
  - 有界指令块规范：在 `chat.message.completed` 文本中嵌入 `<<<orchestrator ... >>>` 的 JSON 指令，驱动协作。
- 后端实现（backend-implementation.md）
  - Orchestrator：订阅 Hub → 解析指令块 → 调用 Codex 客户端 `newConversation/ensure_listener/send_user_message` → 广播 `chat.agent.spawned|report`。
  - 幂等/限流：基于 `eventId` + 可选 `correlationId` 去重；支持限额/超时；必要时持久化。
- 前端实现（frontend-implementation.md）
  - 父会话时间线：显示 `chat.agent.spawned`（锚点）与 `chat.agent.report`（回报）。
  - 协作面板：根据 spawned 中的 `conversationId` 自动订阅/重播子会话并渲染 Turn 序列。
  - 去重与恢复：基于 `provider|conversationId` 游标与 `events.resume(chat, filter)`。
- 测试与验收（testing-and-acceptance.md）
  - 后端单元/集成、前端单测/E2E 用例清单与验收准则。
- FAQ（faq.md）
  - `provider` vs `agentId` 的区别与演进路线；指令块 vs plan_update vs MCP。

## 实施分期（建议）

- P0：Orchestrator 骨架 + 指令块解析 + spawn/send/stop + `chat.agent.spawned`/`report`；前端协作面板与自动订阅；支持刷新/断线后的恢复。
- P1：限额/预算、幂等持久化、UI 筛选/徽标、日志与审计、Ring 容量策略。
- P2：可选 `agentId` 注入、`events.resume` 支持 `agentId` 过滤、MCP 工具化（`orchestrator.spawn/send/stop`）。

---

关联文档：
- `docs/specs/006-chat-history-and-streams-unification.md`
- `docs/guide/codex-chat-turn-ssot.md`

