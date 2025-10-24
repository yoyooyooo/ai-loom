# 003 — WS 双层订阅（status/detail）预案

- 背景：早期草案建议将订阅拆分为“状态流（轻量）+ 详情流（高频）”，以降低 UI 抖动与缓存压力。
- 目标：
  - 定义 status/detail 的边界与消息体；
  - 评估前端缓存与 UI 订阅方式变化的收益；
  - 在单连接/多连接两种模式下的适配方案。
- 验收：
  - 在 `docs/guide/ws-overview.md` 增补“双层订阅（预案）”章节，明确推进与否的决策依据。
- 关联：`docs/guide/ws-overview.md`
