# FAQ（多 Agent 协作）

## provider 与 agentId 有何不同？

- provider：执行器/协议提供方（如 Codex、Claude Code、Gemini CLI），决定“怎么连、能做什么”。目前我们已把 `provider:'codex'` 注入到每条 `chat.*`；Ring 记录 `provider_id` 并支持 resume 过滤。
- agentId：具体智能体实例/角色（如 reviewer/frontend/test），决定“谁在做、职责是什么”。短期可不必强制引入，仅用于 UI 标识；后续如需要更细过滤/命名空间，可在 `chat.*` 补充 `agentId` 与 resume 过滤。

## 一定要用 plan_update 吗？

不需要。我们选“有界指令块（directive block）”方案：在 `chat.message.completed` 文本中嵌入 `<<<orchestrator ... >>>` 的 JSON，服务端 Orchestrator 解析并执行 spawn/send/stop/report。这样避免与模型内置 plan 语义耦合。

## 一定要 MCP 才能多 Agent 吗？

不需要。指令块 + Orchestrator 即可实现“Agent 自主决策触发/协作”。MCP 属于后续增强：把 `orchestrator.spawn/send/stop` 做成 MCP 工具（function_call），获得强类型与更高可靠性；但不是前置条件。

## 断线/刷新后如何恢复？

- 依赖 006 统一化能力：持久 `chat.*` 入 Ring 自动注入 `eventId/ts`；`events.resume({ topic:'chat', filter:{ conversationId, providerId? } })` 返回增量；前端 `convLast[provider|conversationId]` 去重与推进。
- 协作面板：父会话恢复其 `chat.agent.spawned` 列表后，自动恢复每个子会话的订阅与 resume。

## Ring 压力与性能？

- 多子会话并发会放大事件量；建议：
  - 适当调高 `AILOOM_WS_RING_CAP`；
  - 对工具输出做节流/聚合；
  - 仅把“可见必要增量”入 Ring（遵循 006）。

## 安全与审批？

- 继承父会话/系统的 `approvalPolicy/sandbox`；子会话不得放宽权限。
- Profile 中可约束 tools（如禁用 exec/patch）与限额（maxTurns/timeoutSec）。

