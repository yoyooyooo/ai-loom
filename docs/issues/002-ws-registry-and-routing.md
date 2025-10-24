# 002 — WS 多连接 Registry 与路由预案

- 背景：早期 specs 提到未来可按域拆分连接（如 fs/stitch/chat），以隔离 QoS 与流量；当前为单连接即可满足需求。
- 目标：
  - 设计多连接 Registry（管理连接生命周期、订阅恢复、热更新/HMR 安全）。
  - 路由策略：按方法/主题选择连接；失败与回退策略。
- 验收：
  - 在 `docs/guide/ws-overview.md` 增补“多连接/Registry 预案”章节，暂不落地代码。
- 关联：`docs/guide/ws-overview.md`
