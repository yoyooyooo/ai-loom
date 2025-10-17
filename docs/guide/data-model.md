# 数据模型（SSoT）

## DirEntry
- `name: string`
- `path: string`（相对 root）
- `type: 'file'|'dir'`
- `size?: number`

说明：服务端 `EntryType` 已通过 `#[serde(rename_all = "lowercase")]` 对齐小写字符串枚举。

## FileChunk（分页返回）
- 规范字段（camelCase）：
  - `path: string`
  - `language: string`
  - `size: number`
  - `totalLines: number`
  - `startLine: number`
  - `endLine: number`
  - `content: string`
  - `truncated: boolean`
- 实现差异：服务端当前返回 snake_case（`total_lines/start_line/end_line`）。见 `api.md` 对齐建议。

## Annotation
- 通用字段（camelCase）：
  - `id: string`
  - `filePath: string`
  - `startLine: number`
  - `endLine: number`
  - `startColumn?: number`
  - `endColumn?: number`
  - `selectedText: string`
  - `comment: string`
  - `preContextHash?: string`
  - `postContextHash?: string`
  - `fileDigest?: string`
  - `tags?: string[]`
  - `priority?: 'P0'|'P1'|'P2'`（默认 `P1`）
  - `createdAt: string`（RFC3339）
  - `updatedAt: string`（RFC3339）

说明：服务端已实现 Create/Update/Annotation 三类结构，`Annotation` 的 `priority` 为空时由服务端落 `P1`，时间字段由服务端注入。

## 导入/导出 Bundles
- 导出：`{ schemaVersion: '1', annotations: Annotation[], exportedAt: string }`
- 导入：`{ schemaVersion: '1', annotations }` 或 `{ annotations }`
- 合并策略：
  - 主键：`id` 优先；若命中已存在且 `updatedAt` 更旧 → 跳过；新者 → 覆盖。
  - 计数：返回 `{ added, updated, skipped }`。

