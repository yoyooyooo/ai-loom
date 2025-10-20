# WS 协议（JSON-RPC 2.0，初稿）

本协议定义 WebSocket 端点、消息格式、方法映射、订阅/事件、错误码、心跳与流控。目标是在保持 `docs/guide/api.md` 数据契约不变的前提下，实现与 REST 等价的能力并扩展服务端推送。

## 端点与握手

- 路径：`/ws`（已决策；与 REST 并列，避免 `/api` 前缀混淆）。
- 握手成功后，服务端发送一次 `session.welcome` 通知：
  ```json
  { "jsonrpc":"2.0", "method":"session.welcome", "params": { "serverVersion":"<semver>", "features":["jsonrpc","subscriptions"], "limits": { "maxMessageBytes": 6291456, "requestTimeoutMs": 15000 } } }
  ```
  - 如启用 MessagePack/流式，将在 `features` 中宣布（后续版本）。
  - 默认限制值：`maxMessageBytes=6MB`（REST 全文读取硬阈值为 5MB；两者可能不完全等价，见“回退语义”），`requestTimeoutMs=15000`。

## 消息格式（JSON-RPC 2.0 子集）

- 请求：`{ jsonrpc:'2.0', id:string|number, method:string, params?:object }`
- 响应：`{ jsonrpc:'2.0', id, result?:any, error?:{ code:string, message:string, data?:any } }`
- 通知（推送）：`{ jsonrpc:'2.0', method:string, params?:object }`
- 事件扩展：服务端推送的事件（通知）额外包含以下扩展字段，便于前端处理乱序与新鲜度：
  - `ts: string`（RFC3339）事件时间戳
  - `eventId: string`（Hub 全局单调递增序号，用于 `events.resume` 与乱序合并）
  - `version: string`（资源级版本或 etag；`file.changed` 优先使用 `digest` 作为 version；`tree.changed` 可为空或使用内部版本）
- 备注：
  - `error.code` 复用域内错误码（`INVALID_PATH`、`NON_TEXT`、`OVER_LIMIT`、`CONFLICT`、`INTERNAL` 等）。
  - 请求 ID：允许 `string|number`，客户端需确保“单连接内唯一”。客户端应按 `id` 去重处理“重复响应”。
  - 超时与重试：客户端默认在 `15s` 超时撤销请求；仅对“传输级错误/超时/断线/能力不足（如 MESSAGE_TOO_LARGE）”可回退到 REST 或重试。写操作默认不自动重试（避免重复提交）。
  - 错误映射：前端统一将 JSON-RPC 错误映射为 REST 形态 `{ error:{ code,message } }`，并在 Error 对象上保留 `code` 字段，复用既有错误处理链路。

## 参数与路径约定（强约束）

- 路径一律“root 相对”：所有请求参数中的 `path/dir/filePath` 以及事件载荷中的路径字段，必须是“当前服务进程的 root 相对路径”（与 REST 对齐）。
  - 服务端内部可在 root↔workspace 间做映射（见 `docs/specs/ws/file-watch.md` 的“路径范围与 Workspace 映射”）。
  - 如涉及 DB 存取，仍以 workspace 相对路径存储；对外响应再映射回 root 相对。

## 方法映射（与 REST 对齐）

- 目录树
  - `tree.get` → GET `/api/tree` → `params: { dir: string }` → `DirEntry[]`
  - 事件：`tree.changed`
    - 载荷：`{ dir?: string, impactedPaths?: string[], summary?: { created: number, modified: number, deleted: number, moved: number, truncated: boolean }, ts: string }`
    - 说明：`impactedPaths` 可能省略或截断（当变化过多时以 `summary.truncated=true` 指示）。
      - 协同处理策略：未截断时按路径计算“最小目录集合”并精确失效；截断时退化为失效当前视图目录或根。详见 `docs/specs/ws/file-watch.md` 的“前后端协同处理策略（impactedPaths）”。
- 文件
  - `file.getChunk` → GET `/api/file` → `{ path, startLine, maxLines }` → `FileChunk`
  - `file.getFull` → GET `/api/file/full` → `{ path }` → `{ path, language, size, content, digest }`
  - `file.save`（可选）→ REST 等价：PUT `/api/file` → `{ path, content, baseDigest? }` → `{ ok: true, digest } | error(CONFLICT)`
    - 前端默认使用 REST 保存；WS 方法可作为扩展保留（两者写后均广播 `file.changed`）。
  - 事件：`file.changed`
    - 载荷：`{ path: string, kind: 'created'|'modified'|'deleted'|'moved', fromPath?: string, digest?: string, ts: string, eventId: string, version?: string }`
    - 说明：保存成功路径可带 `digest`（同时作为 `version`）；监听触发一般不计算 `digest`（避免 IO）。当同一窗口内既有“写后广播（带 digest）”又有监听合并推送时，应以“带 digest 的事件”为准，客户端可忽略随后的同路径监听事件以避免重复刷新。
- 批注
  - `annotations.list` → GET `/api/annotations` → `Annotation[]`
  - `annotations.create|update|delete|export|import|verify`：首选 REST；WS 方法可选提供实现，事件推送一律通过 WS。
  - 事件：
    - `annotations.created|updated` → `{ annotation: Annotation }`
    - `annotations.deleted` → `{ id: string }`
    - `annotations.verify.done` → `VerifyResultOut`
- Stitch
  - `stitch.generate` → POST `/api/stitch` → `{ prompt, stats }`
  - 事件（可选）：`stitch.progress` → `{ stage, percent, stats? }`

## 订阅模型

- 方法
  - `subscribe`：`{ topic: 'file'|'tree'|'annotations', filter?: object }` → `{ token: string }`
  - `unsubscribe`：`{ token: string }` → `{ ok: true }`
- 主题建议
  - `file`：`filter = { path?: string, prefix?: string }`（推送 `file.changed`）
  - `tree`：`filter = { dir?: string }`（推送 `tree.changed`）
  - `annotations`：`filter = { filePath?: string }`（推送 `annotations.*`）
- 说明
  - 订阅按连接生效，断线自动清理；重连后客户端应主动恢复订阅。
  - 幂等订阅：对（`topic + stable(filter)`）计算稳定哈希作为 `token`，重复订阅返回相同 `token`。`stable(filter)` 采用“键名排序后的 JSON 字符串”作为规范化表示（不含多余空字段），确保不同版本/序的入参得到同一 token。
  - 过滤优先级：`path > prefix`；空过滤表示订阅该主题全部事件。服务端在广播时按订阅做“快速预过滤”，客户端仍需自查防御异常。
  - 仅支持“主题 + 过滤”的订阅形态；不提供“按任意方法名数组”的订阅。客户端如需“多方法”筛选，请对同一 topic 的推送在流内按 `method` 过滤或合并多个订阅流。

## 错误与约束

- 错误码沿用 REST：`INVALID_PATH`、`NON_TEXT`、`OVER_LIMIT`、`CONFLICT`、`NOT_FOUND`、`INTERNAL` 等。
- 消息体积：默认上限 6MB（含编码后 JSON 文本）。当响应/通知将超限时返回 `MESSAGE_TOO_LARGE` 错误且保留连接；客户端应将其视为“能力不足（可回退）”，在读取类请求上自动回退 REST（注意：若 REST 也因 `OVER_LIMIT` 失败，回退同样会失败，但错误语义一致）。
- 频率限制：建议读 100 rps、写 10 rps、订阅 10 rps（服务端实现可调整）。
 - 限额公布：具体限额以 `session.welcome.params.limits` 为准（如 `maxMessageBytes`、`requestTimeoutMs`、`maxConcurrentRequests`、读/写/订阅速率等）。作为 SSoT，本文件是约定源，其它文档不再重复具体数值以避免漂移。

## 心跳与保活

- 服务端每 30s 发送 `session.ping` 通知：`{ method:'session.ping', params:{ ts } }`。
- 客户端在 5s 内以“通知”形式回 `session.pong`：`{ jsonrpc:'2.0', method:'session.pong', params:{ ts } }`。该交互不要求响应，降低实现复杂度。
- 连续 2 个周期未收到 `pong`，服务端关闭连接。客户端需指数退避重连（含抖动），并在连接恢复后“按本地订阅表”自动恢复订阅，并触发一次轻量自检以对齐可能遗漏事件。

## 增量恢复（可选）

- 方法：`events.resume` → `params: { after: string }`，返回 `{ events?: Notification[], truncated?: boolean }`
- 语义：当客户端保存了 `lastEventId` 时，重连后优先尝试拉取断线窗口内的增量；若返回 `truncated=true` 或方法未实现，客户端退化为“粗粒度失效”（参考 client.md 的 query-invalidator 策略）。

## 版本化与能力协商

- 建议在 `session.welcome` 携带 `serverVersion` 与 `features`；当后续引入 MessagePack/流式能力时通过 `features` 协商。

## 未来扩展（非本阶段）

- MessagePack 编解码（`features: ['msgpack']`）。
- 流式/分片：`file.readStream` → `{ streamId }`，随后 `stream.next` 迭代下发内容块。
- 批量请求：单帧携带 `[{id,method,params},...]` 以减少 RTT（需限流）。

## 附：客户端回退策略（wsPrefer）

- 分类：
  - 业务错误（含 `error.code` 且非能力不足类）：不回退，直接交由 UI 处理。
  - 传输/能力错误（以下任一）：回退执行 REST 的等价读取。
    - 连接未建立/断线；请求超时；消息发送失败；帧解析失败；`MESSAGE_TOO_LARGE`。
  - 回退失败：若等价 REST 返回 `OVER_LIMIT/HTTP_XXX` 等，直接按 REST 错误提示（不再二次回退）。
- 超时：默认 `timeoutMs=15000`，支持按方法覆盖。
- 幂等：读取类可透明重试；写入类不自动重试（保留由 UI 触发的“确认后重试”）。

示例（`file.getFull` 超限回退）：
1) WS 返回 `MESSAGE_TOO_LARGE` → 视为能力不足，触发 REST 回退；
2) 若 REST 返回 413 + `{ error:{ code:'OVER_LIMIT' } }` → 停止回退，提示“文件过大不可全量读取”，不再自动重试。
