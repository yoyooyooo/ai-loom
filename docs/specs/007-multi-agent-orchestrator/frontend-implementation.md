# 前端实现（协作面板 + 自动订阅 + Turn-first 保持）

## 目标

- 不改变现有 Turn-first 渲染与 Store 模型，只在父会话中新增“协作信息步”和“协作面板”。
- 自动订阅/重播子会话，保证刷新/断线后的恢复与去重。

## 事件处理

- 父会话时间线新增展示：
  - `chat.agent.spawned`：显示锚点（agent/provider 徽标、目标概述）；点击展开“协作面板”。
  - `chat.agent.report`：以 info 步骤显示子会话回报。
- 订阅策略：
  - 收到 `chat.agent.spawned{ childConversationId }` 后：
    - 调用 `ws.subscribeTopic$('chat', { conversationId: childConversationId })`
    - 执行 `ws.resumeChat(childConversationId)`（基于 `convLast` 补偿）
  - 退订：当父会话离开/关闭协作面板时，可延迟退订（防止抖动）。

## 去重与恢复（已具备能力）

- `convLast` 游标键：`provider|conversationId`（已实现）。
- `events.resume`：`{ topic:'chat', filter:{ conversationId, providerId? }, after, tail }`（已实现）。
- Ring 截断：收到 `truncated: true` → 发出 `session.resync` 轻提示；不影响 Turn 正确性。

## UI 改动

- Turn/步骤徽标：在气泡/步骤上显示 `provider`，后续补 `agentId`。
- 协作面板：
  - 形式：抽屉/侧栏；展示每个子会话的 Turn 列表（可折叠 Reasoning 与工具步骤）。
  - 切换：支持多子会话 Tab；显示流状态与最近 `eventId`。
  - 再交互：在面板内可发送文本到子会话（`send_user_message` 经 REST/WS 触发后端调用 Codex）。

## Store 与服务

- 复用：现有 `features/codex-chat/stores/*` 与 `services/ws.ts` 订阅器。
- 增量：
  - `subscribeChatEvents` 内，识别 `chat.agent.spawned` 并触发子会话订阅与 resume。
  - 可维护一个 `childConversations` 集合（父 cid → 子 cid[]），用来刷新后恢复订阅。

## 验收场景

- 并行：父会话触发 2 个子会话（FE/Review），协作面板能同时展示并各自更新；刷新后自动恢复订阅与补偿。
- 迟到帧：切换视图或面板时，非当前子会话的事件不会污染当前渲染（按 conversationId 守卫）。
- 截断提示：Ring 截断时 UI 轻提示；最终输出与历史一致。

