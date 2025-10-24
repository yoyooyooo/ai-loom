# 008 — WS 本地 Mock 工具集（集成测试辅助）

- 背景：早期有 mock 规划；现实现走真实后端开发较多，仍可保留一套轻量 mock 用于 CI/本地回归。
- 目标：
  - 浏览器内 mock（mock-socket）与 Node 侧 mock（ws）各一种最小可用方案；
  - 覆盖握手/ping/pong、subscribe/unsubscribe、events.resume、断线/回退等关键路径；
  - 与 REST 的 MSW 拦截组合验证 wsPrefer。
- 验收：
  - 在 `docs/guide/ws-overview.md` 附“Mock 与测试”章节，给出最小示例与注意事项；可选：在 packages/web 下放置 demo 测试。
- 关联：`docs/guide/ws-overview.md`
