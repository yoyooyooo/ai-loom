# MCP 集成规范（ai-loom Provider）

## 1. 背景

- 通过 MCP（Model Context Protocol）向外部客户端暴露上下文检索与获取能力，减少复制黏贴与重复抓取的成本。

## 2. 能力概述（MVP）

- 仅暴露 Annotation（批注）上下文，且为只读。
- 工具集：列出批注、获取批注、Stitch 聚合为 Prompt。
- 仅本机连接（127.0.0.1），MVP 无鉴权；响应体积受限。

## 3. 工具定义（MVP）

- `ai-loom.list_contexts(params)`
  - params：`{ kind?: 'annotation', limit?: number, offset?: number }`
  - 返回：`{ items: Annotation[], nextOffset?: number }`

- `ai-loom.get_context(params)`
  - params：`{ id: string }`
  - 返回：`Annotation`

- `ai-loom.stitch(params)`
  - params：`{ templateId?: 'concise'|'detailed', annotationIds?: string[], maxChars?: number }`
  - 返回：`{ prompt: string, stats: { annotations: number, chars: number, files: number, truncated: boolean } }`

说明：
- `annotationIds` 为空或缺省表示使用全部批注；`maxChars` 控制总字符预算，超限将按优先级裁剪。

## 4. 数据形态（Annotation 摘要）

```json
{
  "id": "ann_01HABCD...",
  "filePath": "src/api/tree.ts",
  "startLine": 12,
  "endLine": 28,
  "comment": "需要分页加载，避免大目录阻塞",
  "tags": ["perf"],
  "priority": "P1",
  "createdAt": "2024-10-14T09:12:00Z",
  "updatedAt": "2024-10-14T09:12:00Z"
}
```

## 5. 安全策略（MVP）

- 仅回环（127.0.0.1）监听；默认无鉴权。
- `sensitivity` 级别控制暴露：`public|internal|secret`，其中 `secret` 不通过 MCP 暴露或仅摘要。

## 6. 错误与限制

- 错误码：`NOT_FOUND` `VALIDATION_ERROR` `INTERNAL`
- 体积与速率限制：
  - 单次响应体积默认上限 256KB。
  - `stitch` 支持 `maxChars`，以避免过大上下文；超限返回 `truncated: true`。

## 7. 工具与实现/REST 的关系

- 数据来源：MCP Provider 与 HTTP API 共享同一存储层（SQLite）。
- 等价映射（实现可直接访问存储层，或通过 REST 转发）：
  - `list_contexts(kind='annotation')` ≈ GET `/api/annotations`
  - `get_context(id)` ≈ 读取本地存储（如需要，也可扩展 GET `/api/annotations/:id`）
  - `stitch(...)` ≈ POST `/api/stitch`
- 分页：MCP 层支持 `limit/offset`；REST 端点可后续按需补充分页参数，或由 Provider 在存储层分页后返回。

## 8. 相关文档

- 架构与数据流：docs/specs/architecture.md:11–13、docs/specs/architecture.md:48–50
- 实施模板与改造清单：docs/specs/implementation.md:138–159
- REST 契约（含 `/api/stitch` 与 `/api/annotations`）：docs/specs/api.md:47–127、docs/specs/api.md:82–105
- 路线图与里程碑（M3 MCP Provider）：docs/specs/planing/mvp-roadmap.md:44、docs/specs/planing/mvp-roadmap.md:140–141
