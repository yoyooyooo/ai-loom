# Orchestrator API（启动/状态/取消）

本文定义最小可用的 Orchestrator HTTP API，用于启动固定流程工作流、查询运行状态与取消。实际编排事件仍通过 WS `chat.*` 推进，API 只提供控制面。

## 路径与形态（提案）

- POST `/api/orchestrator/workflows/start`
  - 启动一个工作流运行（绑定父会话）。
  - 请求：
    ```json
    {
      "parentConversationId": "cid-parent",
      "workflowId": "workflow.irtest",
      "variables": { "objective": "实现设置面板", "paths": ["packages/web/src/pages/settings/*"] },
      "budget": { "tokens": 20000, "timeoutSec": 1800 },
      "runId": null
    }
    ```
  - 响应：
    ```json
    { "runId": "run_abc123", "status": "running" }
    ```

- GET `/api/orchestrator/workflows/:runId`
  - 查询运行状态与简要进度。
  - 响应：
    ```json
    {
      "runId": "run_abc123",
      "workflowId": "workflow.irtest",
      "parentConversationId": "cid-parent",
      "status": "running", // running|completed|failed|cancelled
      "steps": [
        { "id": "impl", "status": "completed", "output": { "childCid": "cid-impl" } },
        { "id": "wait_impl", "status": "completed" },
        { "id": "review", "status": "running", "output": { "childCid": "cid-rev" } }
      ],
      "createdAt": "2025-01-01T00:00:00Z",
      "updatedAt": "2025-01-01T00:05:00Z"
    }
    ```

- POST `/api/orchestrator/workflows/:runId/cancel`
  - 取消一个运行中工作流；对活动子会话调用 `interrupt`（可配置是否全部中断）。
  - 响应：`{ "ok": true }`

## 事件流（通过 WS）

- 与 API 配合，进度/协作通过 WS `chat.*` 推送：
  - `chat.workflow.step.begin|end`（父会话）
  - `chat.agent.spawned|report|status`（父会话）
  - 子会话的标准 `chat.message.*`/`chat.reasoning.*`/`chat.tool.*`

## 幂等与恢复

- `runId` 可由客户端指定（可选）；若重复调用 `start` 且 `runId` 一致，服务端返回已存在的运行。
- 运行状态持久化于 `workflow_runs` 与 `workflow_steps`；重启后可继续推进或标记为 `failed`。

## 权限与安全

- 仅允许本地/可信环境调用；启动时继承父会话的 `approvalPolicy/sandbox`。
- 限制可用 `workflowId` 与可覆盖的 `variables` 字段；敏感字段白名单化。

