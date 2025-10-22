# Research: 条件化省略说明（批注复制）

## Decisions

- Decision: 在 `ailoom-stitch::generate_prompt` 中，仅当任一片段文本包含 `<<<OMITTED ~` 前缀（覆盖 `CHARS` 与 `LINES` 两种）时，才输出头部说明行；否则不输出。
- Rationale: 显式标记由裁剪函数插入，检测成本低、无二义性，不依赖额外状态；同时避免因仅长度对比导致的误判。
- Alternatives considered:
  - 方案A：对比 `snippet` 与 `raw`，若长度减少则视为发生省略。放弃：需处理换行规整等无害改写，易引入误报。
  - 方案B：由前端判断是否附加说明。放弃：分散逻辑、与模板/服务端裁剪细节耦合，易漂移且多入口难以统一。
  - 方案C：依据 `stats.truncated` 决定。放弃：`truncated` 表示“条目裁剪到预算导致丢弃后续项”，并非片段内部省略的同一语义。

## Scope Notes

- 模板两类占位符：`<<<OMITTED ~N CHARS>>>`（concise）与 `<<<OMITTED ~N LINES>>>`（detailed）。两者均触发说明行。
- 不改动 `/api/stitch` 的请求/响应结构，仅改变 `prompt` 文本头部是否包含说明。
- 前端复制入口（按钮/菜单/快捷键）不需改动，行为自然统一。

## Test Plan (Unit-level for Rust)

- Case1（无省略）：输入短片段，不触发 collapse，断言 `prompt` 不包含说明行。
- Case2（字符省略）：长字符片段触发 `collapse_middle_chars`，断言 `prompt` 顶部含说明，且仅 1 条。
- Case3（行省略）：多行长片段触发 `collapse_middle_lines`，断言 `prompt` 顶部含说明，且仅 1 条。
- Case4（多片段多次省略）：多个条目均省略，说明仍仅 1 条；`OMITTED` 标记可在多处出现。

## Rollout & Risk

- 风险：若说明行判断不准确，可能出现漏加或误加。通过显式标记检测与单测覆盖降低风险。
- 回滚：保留原始添加逻辑分支，若需快速回滚仅一处修改即可恢复“总是添加”。

