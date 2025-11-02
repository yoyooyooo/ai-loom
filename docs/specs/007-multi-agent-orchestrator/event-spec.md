# 事件与指令规范（Multi-Agent 协作）

本文件定义“多 Agent 编排”涉及的新增事件与指令块格式；所有可见增量仍统一为平台层 `chat.*`，遵循 006 历史统一化与 Turn-first 渲染约束。

## 既有字段（补充约定）

- `conversationId`：必有，标识事件归属的 Codex 会话。
- `provider`：必有（已实现），当前固定值 `'codex'`。
- `agentId`：可选（未来增强），标识参与者实例/角色（如 `reviewer`、`frontend`）。
- `eventId/ts`：由 Hub 注入（入 Ring 的持久事件）。

## 新增信息类事件

- `chat.agent.spawned`
  - 语义：在“父会话”内广播一条锚点，声明已创建一个子 Agent 会话。
  - params：
    - `conversationId`: string（父会话）
    - `childConversationId`: string（子会话）
    - `provider`: string（如 `'codex'`）
    - `agentId`?: string（如 `'reviewer'`）
    - `title`?: string（展示用）
    - `purpose`?: string（简述子任务目的）

- `chat.agent.report`
  - 语义：子 Agent 的阶段性/最终汇报，写回父会话的时间线（信息步骤）。
  - params：
    - `conversationId`: string（父会话）
    - `fromConversationId`: string（子会话）
    - `agentId`?: string
    - `text`: string
    - `refs`?: any（可选引用）

- `chat.agent.status`（可选）
  - 语义：编排/预算/超时/失败等状态通知。
  - params：
    - `conversationId`: string（父会话）
    - `childConversationId`: string
    - `agentId`?: string
    - `status`: 'started'|'running'|'completed'|'failed'|'budget_exceeded'|'timed_out'
    - `reason`?: string

以上均为“持久事件”，应入 Ring 并注入 `eventId/ts`，以供 resume 重播。

## 有界指令块（Directive Block）

- 目的：以零耦合方式，让当前 Agent 在 `chat.message.completed` 文本中嵌入结构化 JSON 指令，驱动协作，无需引入 plan_update 或 MCP。
- 包裹格式：
  - 起始：`<<<orchestrator`
  - 结束：`>>>`
  - 内部：JSON 对象或对象数组，UTF‑8 文本；长度建议 ≤ 16KB。
- 解析策略：
  - Orchestrator 从文本中提取首个合法块；解析失败不影响主流程，可广播 `chat.agent.status{ status:'failed', reason:'invalid_directive' }`。

### 指令对象（最小集合）

- `spawn`：创建子会话
  - 示例：
    ```json
    {
      "action": "spawn",
      "agent": "reviewer",
      "goal": "请评审 FE 变更，重点关注可访问性",
      "handoff": { "context": "本次实现了按钮组件", "files": ["packages/web/src/components/button.tsx"] },
      "constraints": { "maxTurns": 3 },
      "correlationId": "rev-001"
    }
    ```
  - 字段：
    - `action`: 固定为 `'spawn'`
    - `agent`: string | { id?, provider?, model?, systemPrompt?, tools?, limits? }
    - `goal`: string（作为子会话首条 user 消息）
    - `handoff`?: { `context`?: string, `files`?: string[] }
    - `constraints`?: { `maxTurns`?: number, `timeoutSec`?: number }
    - `correlationId`?: string（幂等键）

- `send`：发送消息给已存在子会话
  - `{ "action":"send", "to":"<childConversationId|agentId>", "text":"..." }`

- `stop`：停止子会话
  - `{ "action":"stop", "target":"<childConversationId|agentId>" }`

- `report`：给父会话回报
  - `{ "action":"report", "text":"...", "refs":{...} }`

## Resume 与过滤

- 现状（已实现）：`events.resume({ topic:'chat', filter:{ conversationId, providerId? }, after, tail })`。
- 未来（可选）：当需要对“同会话、同 provider 的多 agent”进行更细粒度隔离时，扩展支持 `filter.agentId`；当前不作为必须项。

## 与 006/SSoT 的关系

- 本规范仅新增信息类事件与指令块，原有 `chat.message.*`、`chat.reasoning.*`、`chat.tool.*`、`chat.turn.*` 行为不变。
- 指令块由 Orchestrator 解析并转化为平台动作，不改变 Turn 的边界与归并逻辑。

