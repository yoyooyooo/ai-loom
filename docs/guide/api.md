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
