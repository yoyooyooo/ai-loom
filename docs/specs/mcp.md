# MCP 集成（状态：未实现）

说明：MVP 尚未实现 MCP Provider；此处仅保留接口意图。与其等价的 REST 能力与数据模型请参考 SSoT：
- 批注与拼接：../guide/api.md、../guide/stitching.md、../guide/data-model.md

计划中的 MCP 工具（概述）：
- `ai-loom.list_contexts(kind='annotation', limit, offset)`
- `ai-loom.get_context(id)`
- `ai-loom.stitch(templateId, annotationIds?, maxChars?)`

安全约束（MVP 预期）：仅 127.0.0.1；无鉴权；响应体积上限。
