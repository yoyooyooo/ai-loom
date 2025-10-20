# WebSocket 改造方案（初稿）

## 背景与现状

- 当前通信为 REST/HTTP，后端基于 Axum：
  - 路由集中于 `packages/rust/ailoom-server/src/router.rs`，提供 `/api/tree`、`/api/file`、`/api/file/full`、`/api/annotations*`、`/api/stitch`、`/api/annotations/verify`。
  - 文件读写：`packages/rust/ailoom-server/src/routes/files.rs`；批注校验：`packages/rust/ailoom-server/src/services/verification.rs`。
- 前端通过 Axios 封装访问 API（`packages/web/src/lib/request.ts`），Explorer 领域 API 位于 `packages/web/src/features/explorer/api/*`；React Query 负责缓存与失效。
- 安全与约束参见 `docs/guide/security.md`：仅绑定回环地址、路径沙箱、非文本限制、写入冲突检测、分页与体积阈值。

## 目标

- 建立单一全双工通道，统一请求-响应与服务端推送，降低轮询/拉取成本，提升交互即时性与一致性。
- 协议采用 JSON-RPC 风格，沿用既有数据模型与错误码（与 `docs/guide/api.md` 对齐）。
- 在不破坏现有安全边界的前提下，引入事件推送（文件变更、批注变更、校验进度、目录树更新等）。
- 前端采用 RxJS 管理 WS 连接/重连/订阅/心跳与事件编排；React Query 继续承担缓存与失效（“推数据直改”与“推事件触发拉取”并用）。订阅统一为“主题 + 过滤”，不提供按任意方法名订阅。

## 最终目标（已决策：Hybrid）

- WS 主导“实时与读取”：订阅/推送，以及 `tree.get`、`file.getChunk`、`file.getFull`、`annotations.list` 等读取优先走 WS（断线自动回退 REST；仅“传输/能力错误”才回退，业务错误不回退）。
- REST 长期保留“简单 CRUD/工具型”：例如 `PUT /api/file`、`POST/PUT/DELETE /api/annotations/*`、`/api/annotations/export|import|verify`、`/api/stitch`。
- 任意写路径（无论经 WS 还是 REST）统一“写后广播”，确保前端实时一致。
- 批注事件承诺：批注 CRUD 无论走 REST 还是 WS，均广播 `annotations.created|updated|deleted`，以支持多客户端同时打开时的实时一致性；校验完成继续广播 `annotations.verify.done`。

备注（Phase 边界）：
- Phase 1 仅落地“读取优先 WS + 写后广播”，不启用 FS 监听与 `stitch.progress`，不引入多连接/registry；仅提供 `singleton` 封装。
- Phase 2 引入订阅扩展、`tree.changed` 与 `annotations.verify.done` 全量事件，以及 FS 监听（节流/合并/上限）。
- Phase 3 评估 WS 写方法与多连接；REST 长期保留为简单 CRUD/工具型通道与兜底。

## 非目标（本阶段）

- 不引入跨机器/公网访问能力，仍仅绑定 `127.0.0.1`。
- 不引入复杂鉴权（必要时做 `Origin` 校验与连接/速率限制）。
- 不追求首版即流式/分片传输，先以与 REST 等价的结果粒度达成目标。

## 范围

- 将 `tree`、`file`、`annotations`、`stitch`、`verify` 相关能力覆盖为 WS 方法；写操作后广播相关事件。
- 前端新增 `ws` 客户端封装（RxJS 版本），React Query 与推送事件打通以实现精确失效与局部状态更新。
- 引入本地文件系统监听（`notify`），合并/节流后推送 `file.changed`、`tree.changed`，并与订阅过滤配合降低噪音。
- 明确通道策略：读取优先 WS、写入默认 REST（可选提供 WS 写方法），统一写后广播。
 - WS 端点路径：`/ws`（已决策，与 REST 并列）。

注：本节“范围”描述整体 WS 改造计划；具体阶段取舍以“备注（Phase 边界）”为准，Phase 1 不包含文件系统监听。

前端规范补充（Query Key，统一口径）：
- 目录树查询 Key 一律采用 `['tree', root, dir]`（`root` = 当前根目录，`dir` = 要查询的子目录，顶层用 `'.'`），以便在多根场景下精确失效；文件内容与批注 Key 维持现状（`['file', path, ...]`、`['annotations']`）。
- 迁移注意：将“页面预热/ensureQueryData/useIsFetching”等涉及 `tree` 相关的两段式键统一替换为三段式键，保持与组件层一致，避免失效不命中。
 - Store 增量：在全局 App Store 中新增 `currentRoot`（默认等于服务 root），统一用于三段式 Key、事件失效器与订阅过滤；保留 `currentDir` 表示当前视图目录。

## 成功标准（验收）

- 功能等价：WS 方法返回字段、错误码与 REST 一致；关键路径交互无回退/闪烁。
- 稳定性：断线重连、订阅恢复、请求超时与重复响应去重齐备。
- 回退策略：读取类在 WS 传输失败/超时/断线/能力不足（`MESSAGE_TOO_LARGE`）时稳定回退 REST（`wsPrefer`），业务错误不回退；若回退 REST 仍 `OVER_LIMIT/HTTP_XXX`，则按 REST 错误提示并终止回退。
- 性能：分页加载/保存/列表等路径延迟不劣于现状；推送合并/节流有效。
- 安全：仍仅回环监听；路径沙箱/非文本限制/写入冲突保持有效。
- Query Key 一致性：仓库内不再存在两段式 `['tree', currentDir]`；预热与组件查询一律使用 `['tree', root, dir]`。
- 事件去重：同一路径的“写后广播（带 digest）”与“监听事件（无 digest）”只触发一次有效刷新（以 digest 事件为准）。

## 术语

- JSON-RPC：`{ jsonrpc:'2.0', id, method, params }`；响应 `{ id, result|error }`；通知（无 id）。
- 订阅：客户端声明感兴趣的资源或事件，服务端按连接维护订阅集合并定向推送。
- 事件：服务端主动发送的无 `id` 消息，包含 `method` 与 `params`。

## 文档地图

- 协议细节：`docs/specs/ws/protocol.md`
- 服务端设计：`docs/specs/ws/server.md`
- 前端设计：`docs/specs/ws/client.md`
- 文件监听：`docs/specs/ws/file-watch.md`
- 实施路线：`docs/specs/ws/migration.md`
- 风险与待决策：`docs/specs/ws/risks-and-decisions.md`
