# 上下文中枢（状态：未实现）

说明：该模块在 MVP 中未实现；仅保留目标简述：统一采集/生成/存储/分发多源上下文（annotation/project_fact/api_route 等），以最小 Token 成本提供高价值上下文。

相关已实现能力参见：
- 批注上下文与拼接：../guide/stitching.md
- 存储与数据模型：../guide/storage.md、../guide/data-model.md

待实现要点：
- Ingestors/Resolvers → Normalizer → Store/Index → Retrieval/Pack 的全链路
- Profile 与优先级策略、快照/包机制
