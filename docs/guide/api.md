# API 契约（规范 + 现状）

说明
- 本节以 camelCase 为规范；后端已对齐（FileChunk 等返回字段为 camelCase）。
- 所有接口均仅本机可访问（服务绑定 127.0.0.1）。

通用错误包装
- 形态：`{ error: { code: string, message: string } }`
- 常见错误码：`INVALID_PATH` `NON_TEXT` `NOT_FOUND` `CONFLICT` `INTERNAL`

目录树
- GET `/api/tree?dir=.`
- 返回 `DirEntry[]`
  - `name: string`
  - `path: string`（相对 root）
  - `type: 'file'|'dir'`
  - `size?: number`（仅文件）

文件分段读取（分页）
- GET `/api/file?path=...&startLine=1&maxLines=2000`
- 返回 `FileChunk`
  - `path: string`
  - `language: string`
  - `size: number`
  - `totalLines: number`
  - `startLine: number`
  - `endLine: number`
  - `content: string`
  - `truncated: boolean`

文件全文读取（用于 Markdown 预览/小文件编辑）
- GET `/api/file/full?path=...`
- 返回 `{ path, language, size, content, digest }`
- 可能返回：`413` + `{ error: { code: 'OVER_LIMIT' } }`（超过硬阈值时拒绝全量读取）

保存文件（带冲突检测）
- PUT `/api/file`
- Body：`{ path: string, content: string, baseDigest?: string }`
- 200：`{ ok: true, digest: string }`
- 409：`{ error: { code: 'CONFLICT', currentDigest: string } }`

批注（Annotation）
- GET `/api/annotations` → `Annotation[]`
- POST `/api/annotations` → `Annotation`
  - Body：`CreateAnnotation`
- PUT `/api/annotations/:id` → `Annotation`
  - Body：`UpdateAnnotation`
- DELETE `/api/annotations/:id` → `{ ok: true }`
- 导出：GET `/api/annotations/export` → `{ schemaVersion: '1', annotations: Annotation[], exportedAt: string }`
- 导入：POST `/api/annotations/import`
  - Body：`{ schemaVersion: '1', annotations }` 或 `{ annotations }`
  - 返回：`{ added: number, updated: number, skipped: number }`
  - 合并规则：按 `id` 去重；若 `id` 相同取 `updatedAt` 新者覆盖；否则插入

批注校验/修正（后端为主）
- POST `/api/annotations/verify`
  - Body：`{ filePath: string, window?: number = 40, fullLimitBytes?: number = 5*1024*1024, removeBroken?: boolean = true }`
  - 作用：对指定文件的批注执行“就近窗口搜索 → 边界锚定（多行）→ 全文（不超过阈值）搜索”，命中则更新行/列，否则按 `removeBroken` 决策删除；`selectedText` 为空将视为无法锚定，删除（当 `removeBroken=true`）
  - 返回：`{ checked, updated, deleted, skipped, updatedIds: string[], deletedIds: string[], skippedIds: string[] }`
  - 触发时机：
    - 后端在 `PUT /api/file` 成功后会自动对该 `filePath` 触发一次校验（后台执行，不影响响应）
  - 路径与作用域：
    - 入参 `filePath` 使用“root 相对路径”；服务端内部会映射为“workspace 相对路径”以查询与更新 DB；响应/列表会再映射回 root 相对路径
    - 仅当前工作区（workspace）且位于当前 `root` 子树下的批注会被返回/处理
  - 算法细节（实现约定）：
    - 窗口搜索：以原 `startLine..endLine` 为中心的 ±`window` 行内，查找 `selectedText`，多候选时取“起始行距离原位置最近”者
    - 边界锚定（多行选区）：在窗口内同时匹配“首行片段”“末行片段”（去除两侧空白后搜索），顺序一致时生成新的 `[startLine..endLine]`
    - 全文搜索：当文件大小 ≤ `fullLimitBytes` 时启用全文匹配，仍按“距离原位置最近”选取
    - 列语义：行内列号计算按“字符数（非字节）”计数，避免多字节 UTF‑8 字符导致切片越界；与部分编辑器（UTF‑16 列）可能存在 1 单位差异，不影响定位与更新
    - 删除策略：若窗口/边界/全文皆未命中且 `removeBroken=true`，则删除该批注；大文件（> `fullLimitBytes`）不进行全文搜索，仍按上述策略处理
  - 幂等性与稳定性：
    - 结果依赖 `selectedText` 的唯一性与上下文；当文本重复或变化较大时，可能更新到“最近的”候选；如需更稳健匹配，可在创建时同时填充 `preContextHash/postContextHash/fileDigest`

Stitch 生成与预算
- POST `/api/stitch?templateId=concise&maxChars=4000`
- Body：`{ annotationIds?: string[] }`（缺省为全部批注）
- 返回：`{ prompt: string, stats: { total, used, truncated, chars } }`
- 细节：排序优先级 P0>P1>P2；同文件内按行号；片段遇三反引号自动升级围栏为四反引号

错误码与前端提示映射（约定）
- `NON_TEXT` 或 `HTTP_415` → “该文件不是可预览的文本”
- `OVER_LIMIT` 或 `HTTP_413` → “文件过大，无法全量读取”
- `CONFLICT` → “保存冲突：文件已被外部修改，请刷新后再试”
- 其它 `HTTP_xxx/NETWORK` → 显示通用错误并透出 message
