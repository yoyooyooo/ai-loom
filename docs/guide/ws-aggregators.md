# WS 聚合器与订阅策略

## 综述

- 聚合器：指前端基于 `ws.events$` 建立的 RxJS 管道，用于跨会话的状态观测或合成（例如 generating 指示器、增量流水线）。
- 精确订阅：自 `v0.0.0` 起，WS `subscribe` 支持在 `filter.methods` 中声明需要的 event method，可组合 `Exact` 与 `Prefix*`。
- 建议：将“聚合器逻辑”与“具体订阅”分离。聚合器只做事件消费；具体订阅点在页面/模块中集中管理，便于在不同视图下启用/关闭。

## chat.info.runtime.generating 聚合

- 后端会在会话进入生成阶段时发 `chat.info.runtime.generating`，收束时置为 `false`。另外每隔 `AILOOM_EXEC_GC_INTERVAL_MS` 推送一次 `session.runtime`。
- 前端推荐如下订阅策略：
  ```ts
  const runtimeSubscription = ws.subscribeTopic$("chat", {
    methods: ["chat.info.runtime.generating", "session.runtime"],
  });
  ```
  - 该订阅不带 `conversationId`，只会接收到运行时相关事件。
  - 聚合器通过 `ws.events$` 过滤即可构建全局状态。
  - 会话层仍按需订阅 `ws.subscribeTopic$('chat', { conversationId })` 值流。
