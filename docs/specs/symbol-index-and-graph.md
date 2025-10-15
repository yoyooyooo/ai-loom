# 符号索引与代码图谱

## 1. 目标

- 提供结构化检索与关系导航能力，支持“低 Token 高价值”的上下文查询与拼接。

## 2. 存储与索引

- 建议：SQLite（嵌入式，事务安全）+ 按需的全文索引（FTS5）
- 表设计（示意）：
  - `items(id, kind, scope, file_path, start_line, end_line, name, symbol_type, payload_json, labels, created_at, updated_at)`
  - `edges(src_id, rel_type, dst_id)`
  - FTS：`items_fts(content: name, file_path, payload_text)`

## 3. 关系类型（部分）

- `defines_route`（symbol → api_route）
- `calls`（symbol → symbol）
- `imports`（file/symbol → symbol/module）
- `belongs_to`（symbol → file/module）
- `declares_type`（file → type）

## 4. 查询模式（示例）

- “GET /api/tree 由谁处理？”
  - `SELECT handler FROM api_route WHERE method='GET' AND path='/api/tree'` → 跳转到 symbol card
- “函数 A 调用了哪些函数？”
  - `SELECT dst_id FROM edges WHERE src_id='symbol:...A' AND rel_type='calls'`
- “列出所有导出的函数及其签名”
  - `SELECT name, payload_json->>'signature' FROM items WHERE kind='code_symbol' AND symbol_type='function' AND payload_json->>'exported' = 'true'`

## 5. LLM 友好返回（Card 格式）

- 限定字段，短文本，包含锚点与位置，便于后续按需展开：
```json
{
  "id": "symbol:src/api/routes.ts#getTree",
  "name": "getTree",
  "signature": "(root: string) => Promise<FileNode[]>",
  "file": "src/api/routes.ts:12-48",
  "exports": true,
  "calls": ["normalizeTree"],
  "links": [
    { "rel": "defines_route", "to": "api_route:GET /api/tree" }
  ]
}
```

## 6. 索引构建策略

- 初次全量；后续 chokidar 监听增量
- 大仓库：分片扫描 + 并发限流；长任务入队列，UI 展示进度

## 7. 兼容基线

- 未支持 AST 的语言：落回 ctags 生成的粗粒度符号卡；后续逐步替换为 AST 归一化

