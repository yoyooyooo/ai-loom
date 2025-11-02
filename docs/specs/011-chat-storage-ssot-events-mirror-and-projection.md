# 011 — Chat Storage SSoT：Events Mirror × Projection（Turns）

本文档整合本轮讨论与实现，给出“以平台层 `chat.*` 事件为单一事实源（SSoT）”的本地存储与恢复方案：事件镜像（Mirror）+ 物化视图（Projection → Turns）+ 大输出脱水（Blobs）。目标是在刷新/断线/多视图/性能/长输出等方面，形成统一、可演进的架构。

## 背景与目标

- 现状痛点：
  - 刷新后重复的 assistant 气泡、海量 delta 刷屏；baseline + WS 双通道重复。
  - 长输出（exec/patch）传输与渲染成本高；开发/生产落盘位置不统一。
  - 前端与后端对语义的拆分导致边界与幂等分歧。
- 目标：
  - 将平台层 `chat.*` 事件作为 SSoT，本地“镜像 + 投影”为稳定的 turn-first 结构，供 HTTP resume 首屏渲染；WS 仅负责增量续写。
  - 长输出统一脱水为 blobs，前端按需懒加载完整体。
  - 清晰的职责边界：后端固化语义，前端专注表达；提供清晰的配置/演进路径。

## 范畴与术语

- Events Mirror（镜像）：
  - 将入环的 `chat.*` 事件按会话/事件序列持久化（append-only）。
  - 用途：断点续传、重放审计、离线恢复、投影增量更新。
- Projection（物化视图）：
  - 基于镜像生成 turn-first 结构（`turns`），包含 steps（thinking/exec/patch/mcp/info）、状态、标题与必要元数据。
  - 版本化输出：`turnsSchemaVersion`。HTTP resume 直接返回本视图，避免首屏再拼接历史与 delta。
- Blobs（大输出脱水）：
  - 针对 exec/patch 等超长正文，脱水落盘，`step.meta` 仅保留 `truncated=true` + `outputBlobId` 以便按需拉取完整体。

## 数据模型（建议）

> 具体落库方案可选 SQLite/嵌入式 KV 等；此处为关系模型草案。

- `events_mirror`（会话事件镜像）：
  - `conversation_id TEXT`、`event_id INTEGER`、`method TEXT`、`params_json TEXT`、`ts TEXT`、`sha256 TEXT`（去重/校验）
  - 复合索引：`(conversation_id, event_id)`
- `turns_projection`（投影视图）：
  - `conversation_id TEXT PRIMARY KEY`、`version INTEGER`（与 turnsSchemaVersion 对齐）、`updated_at TEXT`、`data_json TEXT`
- `blobs_index`（大输出索引）：
  - `blob_id TEXT PRIMARY KEY`、`conversation_id TEXT`、`path TEXT`、`size INTEGER`、`created_at TEXT`、`sha256 TEXT`

## 类型与跨端对齐（已落实）

- Turn 及 Steps 相关结构体统一定义在后端（`packages/rust/ailoom-server/src/routes/chat/resume/turn_types.rs`），视为 SSoT。
- 借助 `ts-rs` 在构建期导出至前端（`packages/web/src/features/codex-chat/types/generated/turns.ts`），前端 store/services 直接引用生成类型，避免双端定义漂移。
- 文档、接口描述、断言统一以该结构为准：新增字段需先更新 Rust 结构体，再导出生成 TS 类型，最后同步前端逻辑。

## 存储位置策略（已实现部分）

- Blobs：
  - 优先（生产默认）：`~/.ailoom/resume-blobs/<conversationId>/<uuid>.txt`
  - 回退（本地/无权限等）：`<workspace>/.ailoom/resume-blobs/<conversationId>/<uuid>.txt`
  - 覆盖：`AILOOM_CHAT_BLOB_DIR=/abs/path` 指定绝对路径（优先级最高）。
  - 实现参考：`shrink_turns_and_emit_blobs`（packages/rust/ailoom-server/src/routes/chat/resume/service.rs）。
  - 懒加载接口 `/api/chat/output` 会按相同的优先级顺序（显式目录 → 用户家目录 → 工作区 `.ailoom`）查找 blob，确保本地开发/生产一致。

## 运行时流程

- HTTP Resume：
  1) 优先读取 `turns_projection`（缺失或过期时即时投影）。
  2) 返回：`{ conversationId, turns, config?, inProgress?, uptoEventId?, turnsSchemaVersion }`。
  3) 不再返回 `history/events`，避免首屏重放与重复。
- WS 订阅握手：
  - `chat.session.sync_begin → (入环 chat.* 补发) → chat.session.sync_end{ uptoEventId }`。
  - 前端处理 `sync_end` 时用 `primeConversationCursor(conversationId, uptoEventId)` 推进已应用游标。
- 游标与幂等：
  - 前端持久化 `convLast/convAppliedLast`；后端以 `eventId/turnSeq/callId` 做去重与映射；Supervisor 负责异常自愈（`session.resync`）。
- 多视图并发：
  - 同连接相同订阅 token（`topic+filter`）共用一次补发（ref_count），避免重复；Hub 按订阅 gating 广播。

## 语义固化（已实现约定）

- Turn-first 边界：首条内容开启，`completed/failed/aborted/turn.complete` 收束。
- Reasoning：统一以 `chat.reasoning.end{text}` 汇聚为 thinking 步骤（`title/body` 已生成），忽略 `response_item.reasoning.summary`。
- 工具：
  - exec：`meta { command: string[], cwd?: string, callId?: string, exitCode?, durationMs?, stdout?, stderr? }`
  - patch：`meta { patch{ files,adds?,dels?,firstPath? }, autoApproved?, changes?, success?, stdout?, stderr? }`；失败时步骤 `status='failed'`
  - mcp：`meta { server, tool, args?, result? }`（兼容 `arguments`）
- 非入环：`chat.turn.started`、`chat.reasoning.delta|section_break` 等瞬时事件仅直播，不入镜像/投影。

## 脱水与拉取（Blobs）

- 阈值：
  - `AILOOM_CHAT_EXEC_BODY_MAX_CHARS`（默认 4000）
  - `AILOOM_CHAT_PATCH_BODY_MAX_CHARS`（默认 8000）
- 行为：
  - 超限正文写入 blob 文件，`step.body` 替换为截断预览，并在 `step.meta` 中写入 `{ truncated:true, outputBlobId }`。
  - 拉取完整体：`GET /api/chat/output?conversationId=<cid>&blobId=<uuid>`。
- 清理策略（建议）：
  - 会话删除时清空 `resume-blobs/<conversationId>`。
  - 追加按时间/容量的 GC（可选 TTL/上限）。

## 配置项（建议）

- `AILOOM_CHAT_STORAGE=off|mirror|mirror+projection`：存储/投影开关（Roadmap）。
- `AILOOM_CHAT_BLOB_DIR=/abs/path`：覆盖 blob 根目录。
- `AILOOM_CHAT_EXEC_BODY_MAX_CHARS`、`AILOOM_CHAT_PATCH_BODY_MAX_CHARS`：预览截断阈值。
- 其余：Ring/握手/去重开关见《WS 概览》与《WS SSoT》文档（`AILOOM_WS_RING_CAP` 等）。

## 演进计划（Roadmap）

- Phase 0（已交付）：
  - Resume 仅返回 turns + uptoEventId；前端只用 turns 首屏渲染；exec 脱水 + 懒加载。
- Phase 1：
  - 引入 `events_mirror`，投影器改为“从镜像增量更新”并持久化至 `turns_projection`。
  - Resume 优先读投影；落盘与回放幂等验证。
- Phase 2：
  - 投影版本化（`turnsSchemaVersion`）、ETag/`updatedAt` 校验；离线首屏。
- Phase 3：
  - GC/压缩（镜像 compaction、blob TTL/容量上限）、导出/清理命令；可选加密或私有路径。

## 边界与异常

- Server 重启导致 `eventId` 归零：
  - 依赖 `uptoEventId` 与本地镜像，确保握手 after 不越界；必要时触发 `session.resync` 与重投影。
- 多视图/多会话：
  - 订阅引用计数仅在 0→1 时补发；token 相同共享一次补发，避免重复。
- Patch/Exec 超大输出：
  - 永远走脱水；projection 中只保留预览与元信息。

## 验证与测试（提要）

- 后端：
  - 映射/边界/工具路径/失败态/脱水阈值 的单测（已覆盖）。
- 前端：
  - turns 首屏渲染 + uptoEventId 游标推进（已覆盖）；history/events 路径已清理。

---

本文档为总体设计草案，后续会细化：镜像/投影的落库 schema、API 变更、GC 与导出策略，以及跨版本升级路径。
