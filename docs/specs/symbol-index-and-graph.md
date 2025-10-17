# 符号索引与代码图谱（状态：未实现）

说明：MVP 未实现该能力；本文件仅保留简述与指向。已实现的上下文聚合参见：../guide/stitching.md。

后续实现方向（概述）：
- 存储：`items`（符号卡）与 `edges`（关系），可选 FTS5。
- 关系：calls/imports/defines_route/belongs_to 等。
- 查询：按符号/文件/路由检索与跳转，LLM 友好的卡片返回。
