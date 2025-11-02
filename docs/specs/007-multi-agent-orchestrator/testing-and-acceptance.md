# 测试与验收

## 后端（Rust）

- Orchestrator（新增）
  - 指令解析：`extract_directives` 能从含有多段文本中准确提取首个合法块；无块/非法块不 panic。
  - spawn 动作：
    - 调用 `new_conversation` 成功 → `ensure_listener(child)` 被调用 → 首条 `send_user_message(child, goal)` 被发送。
    - 广播 `chat.agent.spawned{ childConversationId }` 入 Ring，含 `provider`，可 resume。
  - send/stop/report：
    - send → Codex 收到 `sendUserMessage`；report → 父会话收到 `chat.agent.report` 并入 Ring；stop → `interruptConversation` 调用。
  - 幂等：同一 `(parentCid, triggerEventId, correlationId?)` 重入不重复 spawn。

- Hub/Resume（扩展已完成）
  - `resume_after_chat_filters_by_conversation_and_provider`（已加单测）。
  - `events.resume(topic='chat', filter={ conversationId, providerId })` 正确返回增量；`tail` 仅在 `after==0` 时生效。

## 前端（TypeScript/Vitest）

- WS 客户端
  - `convLast` 使用 `provider|conversationId` 游标键；重复/过期 `eventId` 丢弃（已加单测）。
  - `resumeChatWithFilter` 会在 `events.resume` 参数里携带 `providerId` 并正确更新命名空间游标（已加单测）。

- 协作面板
  - 收到 `chat.agent.spawned` 自动订阅子会话；刷新后根据 spawned 列表恢复订阅/补偿。
  - 多子会话并行：A/B 两个子会话交错事件，面板各自正确渲染，互不串台。

## E2E（最小）

- 场景：父会话里发送“指令块”文本 → 后端 Orchestrator 触发 spawn → 前端出现协作面板并显示子会话的流式响应；刷新浏览器 → 父/子会话均通过 resume 恢复，时间线连续无重复。

## 验收清单

- Turn-first 不变：父/子会话内的 Turn 边界与渲染符合 `docs/guide/codex-chat-turn-ssot.md`。
- 指令块驱动：spawn/send/stop/report 指令被正确识别并执行；失败场景有状态事件（如 invalid_directive）。
- 并发协作：多个子会话并发运行时，父会话可同时查看；Ring 截断/断线后 resume 可恢复。

