# 007 — API 错误码 SSoT（REST ⇄ WS 对照）

- 背景：错误码在 REST 与 WS 之间需集中对照（如 HTTP_413 ⇄ MESSAGE_TOO_LARGE），便于前端统一处理与测试。
- 目标：
  - 建立错误码 SSoT 表（推荐放在 `docs/guide/ws-overview.md` 或新增 `docs/guide/api-errors.md`）。
  - PR 审查项：新增方法需补充到表中并附带最小测试用例。
- 验收：
  - 文档与实现一致；前端包装（toHttpError/wsPrefer）遵循该对照表。
- 关联：`docs/guide/ws-overview.md`
