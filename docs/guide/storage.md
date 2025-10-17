# 存储层（SQLite）

连接与参数
- 打开方式：`sqlx` + SQLite 连接池（最大连接 8）。
- PRAGMA：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=3000ms`。

数据库路径与工作区隔离
- 默认：`~/ailoom/ailoom.db`（Windows：`%USERPROFILE%\ailoom\ailoom.db`）。
- 打开失败时回退：项目根的 `.ailoom/ailoom.db`（会自动创建父目录）。
- 隔离策略：在同一个全局数据库内按“工作区 ID（workspace_id）”隔离数据。workspace_id 为 UUID（v4），而 `key` 为规范化绝对路径（向上查找最近 `.git` 作为根，未找到则用 `--root`）。
- 可见性：仅返回“当前 `--root` 子树”范围内的批注。存储时统一使用“相对工作区根”的路径，响应时映射为“相对当前 `--root`”的路径。

表结构（已实现）
- `annotations`（主键 `id`）
  - `file_path/start_line/end_line/start_column/end_column/selected_text/comment`
  - `pre_context_hash/post_context_hash/file_digest/tags/priority`
  - `created_at/updated_at`
  - `workspace_id`（按工作区隔离，值等于 `workspaces.id`，为 UUID）
- 索引：
  - `idx_annotations_file_path(file_path)`
  - `idx_annotations_created_at(created_at)`
  - `idx_annotations_file_span_created(file_path,start_line,end_line,created_at)`
  - `idx_annotations_ws_id(workspace_id)`、`idx_annotations_ws_id_file(workspace_id,file_path)`

- `workspaces`（工作区元信息，按路径唯一）
  - `id`（`TEXT PRIMARY KEY`，当前等同于 `key`）
  - `key`（规范化绝对路径，`UNIQUE NOT NULL`）
  - `root_path`（与 `key` 等值，保留字段，后续便于扩展）
  - `created_at/updated_at`（ISO8601 文本）
  - 索引：`idx_workspaces_updated_at`；唯一约束：`key`

能力
- `list_annotations/insert/update/delete/get/export_all` 均已实现。
- 导入合并：按 `id` 判断存在（同一工作区）；若 `updated_at` 更新则覆盖，否则跳过；统计新增/更新/跳过数量。
- 按 ID 列表查询：构造 `IN (?)` 动态语句，缺省时回落到 `list_annotations`。

后续演进（预留）
- Context Item 与关系表（edges/FTS）按 `docs/specs/symbol-index-and-graph.md` 规划，MVP 未实现。

外键与约束
- 关系：`annotations.workspace_id` → `workspaces.id`
- 约束：`FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT ON UPDATE CASCADE`
  - 删除工作区：RESTRICT（若有批注，将被数据库阻止删除）。
  - 更新工作区 ID：CASCADE（不常见；若发生会联动更新子表引用）。
- 校验：所有连接在建立时执行 `PRAGMA foreign_keys=ON;`，确保外键约束生效。
- 导入顺序：若做批量导入，应先写入/确保 `workspaces`，再插入 `annotations`，避免外键校验失败。
