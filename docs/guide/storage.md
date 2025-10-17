# 存储层（SQLite）

连接与参数
- 打开方式：`sqlx` + SQLite 连接池（最大连接 8）。
- PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=3000ms`。

数据库路径
- 默认：`~/ailoom/ailoom.db`（Windows：`%USERPROFILE%\ailoom\ailoom.db`）。
- 打开失败时回退：项目根的 `.ailoom/ailoom.db`（会自动创建父目录）。

表结构（已实现）
- `annotations`（主键 `id`）
  - `file_path/start_line/end_line/start_column/end_column/selected_text/comment`
  - `pre_context_hash/post_context_hash/file_digest/tags/priority`
  - `created_at/updated_at`
- 索引：
  - `idx_annotations_file_path(file_path)`
  - `idx_annotations_created_at(created_at)`
  - `idx_annotations_file_span_created(file_path,start_line,end_line,created_at)`

能力
- `list_annotations/insert/update/delete/get/export_all` 均已实现。
- 导入合并：按 `id` 判断存在；若 `updated_at` 更新则覆盖，否则跳过；统计新增/更新/跳过数量。
- 按 ID 列表查询：构造 `IN (?)` 动态语句，缺省时回落到 `list_annotations`。

后续演进（预留）
- Context Item 与关系表（edges/FTS）按 `docs/specs/symbol-index-and-graph.md` 规划，MVP 未实现。

