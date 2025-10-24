# MCP 集成（状态：部分实现，优先 `<server>__<tool>` 命名）

现状：
- Resume/WS 路径已统一映射 `mcp_tool_call_begin|end` 与 `response_item(function_call)` 到平台层 `chat.tool.mcp.(begin|end)`。
- 工具命名优先采用 `<server>__<tool>`，兼容 `mcp__server__tool`、`mcp:server/tool`、`server/tool`。

仍需推进：
- 更丰富的结果/错误结构体（参数与返回值的类型化展示）。
- 与 UI 的更紧密联动（分页/折叠策略、搜索与筛选）。
- Server 端聚合/审计（调用频次、耗时与失败率）。

说明：MVP 尚未实现 MCP Provider；此处仅保留接口意图。与其等价的 REST 能力与数据模型请参考 SSoT：
- 批注与拼接：../guide/api.md、../guide/stitching.md、../guide/data-model.md

计划中的 MCP 工具（概述）：
- `ai-loom.list_contexts(kind='annotation', limit, offset)`
- `ai-loom.get_context(id)`
- `ai-loom.stitch(templateId, annotationIds?, maxChars?)`

安全约束（MVP 预期）：仅 127.0.0.1；无鉴权；响应体积上限。
