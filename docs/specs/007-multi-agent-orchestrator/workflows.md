# 工作流规范（Templates + 轻引擎）

本文定义“固定流程工作流”的模板格式与执行语义，聚焦高 ROI 的多 Agent 场景（实现→评审→测试、FE/BE 分治、热修复等）。本规范建立在 007 方案（事件与 Orchestrator）之上，并保持 006/SSoT 约束不变。

## 设计目标

- 用可读的 JSON 模板描述“专职 Agent + 步骤编排”，最小变量化，可按仓库/目录定制。
- Orchestrator 解释执行模板：按 Step 触发 `spawn/send/stop/wait/join/approval` 等动作；进度以 `chat.workflow.step.begin/end` 体现。
- 与 ad-hoc 指令块共存：模板用于“固定流程”，指令块用于“一次性临时协作”。

## 模板形态

- 存放位置：`.ailoom/workflows/*.json`（或 UI 侧存储后端 DB 中，落库时按本格式映射）。
- 结构（示例字段，非严格 JSON Schema）：
```jsonc
{
  "id": "workflow.irtest",
  "title": "实现→评审→测试",
  "description": "典型质量闭环，评审禁工具，测试最小即可",
  "limits": { "maxAgents": 3, "budgetTokens": 20000, "timeoutSec": 1800 },
  "variables": {
    "objective": { "type": "string", "required": true },
    "paths": { "type": "string[]", "required": false, "default": [] }
  },
  "steps": [
    // step 列表，详见下节
  ]
}
```

## Step 类型与字段

通用字段（所有 Step 均可含以下字段）：
- `id`: string（必填，工作流内唯一）
- `title`?: string（展示名）
- `if`?: 条件表达式（见变量与表达式）
- `timeoutSec`?: number（覆盖模板级）
- `onError`?: 'continue'|'stop'（默认 stop）
- `parallelGroup`?: string（同组并行；与 `join` 配合）

具体 Step：
- `spawnAgent`
  - `type`: 'spawnAgent'
  - `agent`: string | { id?: string, provider?: 'codex', model?: string, systemPrompt?: string, tools?: { exec?: boolean, patch?: boolean }, limits?: { maxTurns?: number, timeoutSec?: number } }
  - `goal`: string（支持变量插值，如 `${objective}`）
  - `inputs`?: object（仅传必要路径/引用，如 `{ paths: ${paths} }`）
  - `handoff`?: { context?: string, files?: string[] }
  - `setVar`?: 将子会话 id/agentId 写入变量：`{ childCidVar: 'feCid', agentIdVar: 'feAgent' }`

- `send`
  - `type`: 'send'
  - `to`: string（变量名或字面量，指向 conversationId/agentId）
  - `text`: string（变量插值）

- `stop`
  - `type`: 'stop'
  - `target`: string（conversationId/agentId）

- `waitFor`
  - `type`: 'waitFor'
  - `event`: 'report'|'completed'|{ "pattern"?: string, "from"?: string }
  - `from`?: string（限定来源 conversationId/agentId 变量）
  - `timeoutSec`?: number（超时按 onError 处理）

- `join`
  - `type`: 'join'
  - `parallelGroup`: string（等待该组内所有并行 Step 结束）

- `approval`
  - `type`: 'approval'
  - `question`: string（展示在 UI，人工确认继续）

- `setVar`
  - `type`: 'setVar'
  - `assign`: { [varName: string]: any }（支持插值）

## 变量与表达式

- 变量来源：
  - 启动时传入的 `variables`（如 `objective/paths`）
  - 先前 Step 的 `setVar` 结果（如保存子会话 id）
  - 运行时事件的派生（如 waitFor 捕获的 `report.text`）
- 插值格式：`${varName}`；数组/对象会 JSON.stringify 再注入文本。
- 条件 `if`：最小实现支持 `var == 'literal'`、`!var`、`var.length > 0`；复杂表达式可后续扩展。

## 执行语义

- 顺序执行默认串行；同 `parallelGroup` 的 `spawnAgent/send/waitFor` 等视为并行提交；`join` 等待该组收敛。
- Begin/End 事件：
  - 每个 Step 执行前广播一次 `chat.workflow.step.begin{ stepId, title }`（持久）
  - 执行后广播一次 `chat.workflow.step.end{ stepId, status, error? }`（持久）
- 与 007 事件的关系：
  - `spawnAgent` 内部会调用 `newConversation/ensure_listener/sendUserMessage` 并在父会话广播 `chat.agent.spawned`；
  - 子会话回报可通过 `report` 指令块 → `chat.agent.report` 回写父会话；`waitFor{event:'report'}` 可据此推进。
- 幂等：
  - 每个 Step 具备 `(runId, stepId)` 去重，运行记录落表 `workflow_steps`；系统重启后可恢复继续。

## 示例模板

### 1) 实现→评审→测试（串行 I-R-T）

```json
{
  "id": "workflow.irtest",
  "title": "实现→评审→测试",
  "variables": { "objective": {"type":"string","required":true}, "paths": {"type":"string[]","required":false, "default":[]} },
  "limits": { "budgetTokens": 20000, "timeoutSec": 1800 },
  "steps": [
    { "id": "impl", "type": "spawnAgent", "agent": "implementer", "goal": "${objective}", "inputs": {"paths": "${paths}"}, "setVar": {"childCidVar":"implCid"} },
    { "id": "wait_impl", "type": "waitFor", "event": "completed", "from": "${implCid}", "timeoutSec": 900 },
    { "id": "review", "type": "spawnAgent", "agent": {"id":"reviewer","tools":{"exec":false,"patch":false}}, "goal": "评审实现结果，提出问题与改进建议", "setVar": {"childCidVar":"revCid"} },
    { "id": "wait_rev", "type": "waitFor", "event": "report", "from": "${revCid}", "timeoutSec": 600 },
    { "id": "test", "type": "spawnAgent", "agent": "tester", "goal": "编写并运行最小测试验证变更", "setVar": {"childCidVar":"testCid"} },
    { "id": "wait_test", "type": "waitFor", "event": "report", "from": "${testCid}", "timeoutSec": 600 }
  ]
}
```

### 2) FE/BE 并行（并发 + 汇合）

```json
{
  "id": "workflow.febe_parallel",
  "title": "前后端分治并行",
  "variables": { "objective": {"type":"string","required":true}, "fePaths": {"type":"string[]"}, "bePaths": {"type":"string[]"} },
  "steps": [
    { "id": "fe", "type": "spawnAgent", "parallelGroup":"febe", "agent": "frontend", "goal": "${objective} (前端)", "inputs": {"paths":"${fePaths}"}, "setVar": {"childCidVar":"feCid"} },
    { "id": "be", "type": "spawnAgent", "parallelGroup":"febe", "agent": "backend", "goal": "${objective} (后端)", "inputs": {"paths":"${bePaths}"}, "setVar": {"childCidVar":"beCid"} },
    { "id": "join_febe", "type": "join", "parallelGroup": "febe" },
    { "id": "review_all", "type": "spawnAgent", "agent": {"id":"reviewer","tools":{"exec":false,"patch":false}}, "goal": "整体评审 FE/BE 变更" }
  ]
}
```

### 3) 热修复（审批门）

```json
{
  "id": "workflow.hotfix",
  "title": "热修复（审批）",
  "variables": { "objective": {"type":"string","required":true}, "paths": {"type":"string[]","default":[]} },
  "steps": [
    { "id": "impl", "type": "spawnAgent", "agent": "implementer", "goal": "${objective}", "inputs": {"paths": "${paths}"}, "setVar": {"childCidVar":"implCid"} },
    { "id": "approval_gate", "type": "approval", "question": "确认应用热修复？" },
    { "id": "merge", "type": "send", "to": "${implCid}", "text": "请生成最终补丁并应用" }
  ]
}
```

## 与指令块的协同

- 模板负责“固定流程”；指令块负责“临时协作”。
- 引擎与 Orchestrator 共用一致的 spawn/send/stop/report 实现，事件面一致（`chat.agent.spawned/report/status`）。

## 数据与恢复（简）

- 落表：`workflow_runs(runId,parentCid,workflowId,status,createdAt,vars)`、`workflow_steps(runId,stepId,status,output,startedAt,endedAt)`、`agent_links(parentCid,childCid,agentId,provider,createdAt)`。
- 恢复：重启后依据 `workflow_runs` 与 `workflow_steps` 重建状态机；父会话 resume 后读取 `agent_links` 恢复子会话订阅。

