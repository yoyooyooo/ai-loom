# Data Model: 条件化省略说明（批注复制）

本功能不引入持久化数据结构变更，以下为“文档级”实体定义，明确行为边界。

## Entities

- CopiedPrompt（复制文本）
  - header: string?  // 可选；仅当存在省略标记时出现固定中文说明
  - body: string     // 批注拼接后的主体文本

- OmissionMarker（省略占位符）
  - forms:
    - "<<<OMITTED ~N CHARS>>>"
    - "<<<OMITTED ~N LINES>>>"
  - semantics: 表示中部省略的字符数或行数

## Invariants

- 若 `body` 中任意片段包含 `OmissionMarker`，则 `header` 必须存在且仅一行；否则 `header` 必须不存在。
- `header` 与 `body` 之间以单个空行分隔；不增加多余空行。

## Validation Rules

- Copy 输出生成后，执行以下校验：
  1) 正则 `<<<OMITTED ~\d+ (CHARS|LINES)>>>` 是否在 `body` 中至少出现一次；若是，校验 `header` 存在。
  2) 若未出现该正则，校验 `header` 不存在。
  3) `header` 出现次数必须为 1，且位置在全文首行。

