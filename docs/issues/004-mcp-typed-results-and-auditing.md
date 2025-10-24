# 004 — MCP 结果类型化与审计指标

- 背景：现已统一 `mcp_tool_call_begin|end` 与 `response_item(function_call)` 到平台层 `chat.tool.mcp.*`，并采用 `<server>__<tool>` 命名规则。
- 目标：
  - UI 类型化展示：参数/结果结构体的友好渲染（JSON schema 映射、折叠/分页）。
  - 指标与审计：调用频次、耗时、失败率；可视化或 `/debug` 曝光。
- 验收：
  - 在 `docs/guide/codex-chat-turn-ssot.md` 增补 MCP 展示与指标建议；前端最小实现方案列出。
- 关联：`docs/guide/codex-chat-turn-ssot.md`
