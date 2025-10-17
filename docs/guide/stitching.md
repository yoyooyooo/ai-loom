# Stitch 拼接与 Token 预算（已实现）

模板与入参
- 模板：`concise`（默认）/`detailed`（大小写不敏感）。
- 入参：`maxChars`（默认 4000，范围 [200, 200000]），`annotationIds?: string[]`（缺省表示全量）。

排序与裁剪
- 排序：`priority` P0→P1→P2，其次 `filePath` 升序，文件内 `startLine` 升序。
- 片段：
  - concise：基于字符的“中间省略”，保留前 60/后 60，最多 120 字符，插入 `<<<OMITTED ~N CHARS>>>`。
  - detailed：基于行的“中间省略”，保留前 20/后 20 行，最多 40 行，插入 `<<<OMITTED ~N LINES>>>`。
- 围栏冲突：若选区含三反引号，自动使用四反引号围栏以避免嵌套冲突。

返回
- `{ prompt: string, stats: { total: number, used: number, truncated: boolean, chars: number } }`
- `truncated=true` 表示未能纳入全部批注（预算不足或单条超限）。

使用建议
- concise 用于外部 LLM 的高效上下文；detailed 用于完整复现与交接。
- 后续可在存储层加入“估算 Token”字段，拼接前预估预算。

