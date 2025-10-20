# 服务端设计（Axum，初稿）

目标：在保留现有 REST 路由的同时新增 `/ws` 端点，实现 JSON-RPC 分发、连接管理、订阅/事件推送，并尽量复用现有业务逻辑（`routes/*`、`services/*`）。

## 路由与模块

- `router.rs` 新增：`.route("/ws", get(ws_upgrade_handler))`
- 新增模块 `src/ws/*`：
  - `protocol.rs`：JSON 编解码、请求/响应/通知结构与错误映射
  - `conn.rs`：单连接读写循环、心跳、请求路由、订阅表
  - `hub.rs`：全局事件总线（`broadcast::Sender<Event>`）、连接注册/注销、面向主题的分发
- `methods.rs`：WS 方法到业务函数的映射层（调用 `services/*` 或现有 `routes/*` 中间逻辑）
- `watch.rs`：文件系统监听与事件归并（基于 `notify`，见 `docs/specs/ws/file-watch.md`）

Phase 边界（首版约束）：
- Phase 1 不启用 `watch.rs`（FS 监听）；仅靠写后广播维持实时一致。
- Phase 1 仅提供 `singleton` 连接（多连接/registry 留作 Phase 3）。

- 应用状态注入：`AppState` 增加可选 Hub 句柄（如 `ws_hub: Option<HubHandle>`），在构建 Router 前完成初始化与注入，便于业务路径在成功写入后推送事件。

## 连接管理与订阅

- 每个连接维护：
  - `pending_requests: HashMap<Id, oneshot::Sender<Response>>`
  - `subscriptions: HashMap<Token, Subscription>`（主题 `topic` + 过滤 `filter`）
  - `out_tx: mpsc::Sender<Text/Binary>`（有界，防止背压）
- `subscribe`/`unsubscribe` 方法修改连接内订阅表；Hub 仅感知“主题→连接集合”的索引以定向广播。
  - 主题：`file`/`tree`/`annotations`；支持过滤：`file:{ path|prefix }`、`tree:{ dir }`、`annotations:{ filePath }`
  - 重复订阅：按（`topic+stable(filter)`）计算稳定哈希作为 `token`，同连接重复订阅返回相同 `token`（幂等）；断开连接自动清理。`stable(filter)` 采用“键名排序后的 JSON 字符串”（剔除空/缺省字段），确保不同字段顺序/版本序列化一致得到同一 token。
 - 仅支持“主题 + 过滤”的订阅形态；不提供“按任意方法名”订阅。全局低频通知仅 `session.*`（无需显式订阅）。

事件顺序与幂等（建议约定）：
- 广播载荷附带 `ts` 与 `version` 字段；前端以“更大版本”为准，拒绝回退。
- 同主题/同 key 的事件在 Hub 内尽量保持有序；当发生合并/丢弃时记录计数，并设置 `summary.truncated=true` 提示客户端退化刷新。
 - 当同一窗口内同时存在“写后广播（通常带 `digest`）”与“FS 监听合并事件”时，对同一路径的冲突推送以“带 `digest` 的事件”为准；Hub 可选择丢弃/去重监听侧的同路径事件，或为其标记 `reduced=true`，客户端据此忽略重复失效。

增量恢复（resume，断线补偿，建议）：
- 可选实现 `events.resume` 方法：`{ method:'events.resume', params:{ after: lastEventId } }` → `{ events?: Event[] }`
 - Hub 维护最近广播的 ring-buffer（如 1024 条）与单调递增 `eventId`（全局或按连接单调）；重连成功且客户端提交 `lastEventId` 时，返回该序号之后的增量事件；若 ring-buffer 不足或版本过旧，返回 `{ ok:false, truncated:true }`，客户端执行“粗粒度失效”对齐（参考 client.md）。推送事件需同时包含 `eventId` 与资源级 `version`（如 `file.changed.digest`）。

## 方法分发与复用

- 读路径：方法层直接调用 `services` 与 `ailoom_fs`、`ailoom_store`，复用 REST 的数据结构与错误映射。
- 写路径：如 `file.save` 成功后：
  - 触发现有 `verify_annotations_for_file`（已在 REST 路由中做异步触发）
  - 广播 `file.changed{ path, kind:'modified', digest }`；校验完成后广播 `annotations.verify.done{ ... }`
  - 其它写路径（批注 CRUD）同理推送 `annotations.created|updated|deleted`

已实现的方法（Phase 1/2/3 部分）：
- 读取：`tree.get`、`file.getChunk`、`file.getFull`、`annotations.list`
- 订阅：`subscribe`、`unsubscribe`
- 增量：`events.resume{ after }`（ring-buffer 补发；不足返回 `truncated=true`）
- 信息：`session.info`（`serverVersion/features/limits/stats`）
- 写入（可选）：`file.save`（与 REST PUT `/api/file` 等价，默认仍用 REST 写；前端开关 `VITE_WS_WRITE=1` 可改走 WS 写）

### 实现触点（REST 路由内写后广播，强约束）

- `routes/files.rs::api_file_put` 成功分支：
  - 取得新 `digest` 后，通过注入的 `HubHandle` 广播：
    - `topic='file'`、`method='file.changed'`、`params={ path, kind:'modified', digest, ts, eventId }`
  - 随后异步触发 `verify_annotations_for_file`；校验流程结束后再广播 `annotations.verify.done{ ... }`。
- `routes/annotations.rs` 成功分支：
  - `create` → 广播 `annotations.created{ annotation }`
  - `update` → 广播 `annotations.updated{ annotation }`
  - `delete` → 广播 `annotations.deleted{ id }`

注意：
- 广播失败不得影响写入事务（连接异常/背压丢弃等场景下应记录 `tracing`，但不回滚业务写）。
- `params.path` 等路径字段一律使用“root 相对路径”。
- 当同窗口内既收到“写后广播（带 digest）”与“FS 监听合并事件（无 digest）”，Hub 可对同路径监听事件降权/丢弃（或标记 `reduced=true`），避免前端重复刷新。

## 信息与观测

- 欢迎包：`session.welcome{ features, limits }`，`limits` 至少含 `maxMessageBytes`、`requestTimeoutMs`。
- 信息接口：`session.info` 返回 `serverVersion`、`features`、`limits` 与 Hub `stats` 快照。
- 周期统计：服务端每 2s 广播一次 `session.stats`（无需订阅），包含：
  - ring：`ringSize/ringCap/lastEventId`
  - 广播：`broadcastTotal/broadcastErrors/noReceiver`
  - QoS：`droppedRingLowpri`（低优先 tree.changed 的 ring 丢弃计数）
  - file：`fileChangedTotal`
  - tree：`treeChangedBatches/treeImpactedPathsTotal/treeMovedTotal/treeTruncatedBatches`

## 配置与安全

- FS 监听：
  - 开关：`AILOOM_FSWATCH_ENABLED=1`
  - 合批：`AILOOM_FSWATCH_BATCH_MS`（默认 300）/`AILOOM_FSWATCH_MAX_WINDOW_MS`（默认 1000）
  - 上限：`AILOOM_FSWATCH_MAX_IMPACTED`（默认 200）
  - 忽略：`AILOOM_FSWATCH_IGNORE_VCS=1`（合并 .gitignore）、`AILOOM_FSWATCH_IGNORE_AILOOM=1`（合并 .ailoomignore）；硬排除 `.git/`、`node_modules/`
- WS Origin：
  - 允许任意（默认）：`AILOOM_WS_ALLOW_ANY_ORIGIN=1`
  - 白名单：`AILOOM_WS_ALLOW_ANY_ORIGIN=0` + `AILOOM_WS_ALLOWED_ORIGINS='http://127.0.0.1:5173,http://localhost:5173'`

### 示例（开发环境 .env 样例）

```
# Web 前端
VITE_USE_WS=1
VITE_WS_DEBUG=1
# VITE_WS_TIMEOUT_MS=15000
# VITE_WS_FUSE_MS=1500
# 可选：WS 写入
# VITE_WS_WRITE=1

# 后端监听（可选）
AILOOM_FSWATCH_ENABLED=0
AILOOM_FSWATCH_BATCH_MS=300
AILOOM_FSWATCH_MAX_WINDOW_MS=1000
AILOOM_FSWATCH_MAX_IMPACTED=200
AILOOM_FSWATCH_IGNORE_VCS=1
AILOOM_FSWATCH_IGNORE_AILOOM=1

# WS Origin（本地开发默认放开）
AILOOM_WS_ALLOW_ANY_ORIGIN=1
# AILOOM_WS_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173
```

## 故障排查（Troubleshooting）

- 浏览器/前端 WS 连接失败（403）：检查 WS Origin 白名单；开发环境可临时设置 `AILOOM_WS_ALLOW_ANY_ORIGIN=1`。
- `MESSAGE_TOO_LARGE`：WS 读取能力不足，前端会自动回退 REST；如 REST 返回 413 + `OVER_LIMIT`，为预期（全文读取阈值更低）。
- `events.resume` 返回 `truncated=true`：ring-buffer 不足或 lastEventId 过旧，前端会执行粗粒度刷新；必要时增大 buffer 或缩短断线窗口。
- FS 监听不生效/卡住：在容器/沙箱平台可能不可用；默认关闭。手动启用前确认环境支持；运行测试用例时使用 `--ignored` 并给 watcher 预热时间。
- Dev 升级失败（Vite 代理）：确认 `vite.config.ts` 已为 `/ws` 配置 `ws:true` 且 `VITE_API_BASE` 指向后端地址。
- 事件风暴/丢弃：查看 `session.stats` 中 ring 大小与 `droppedRingLowpri`，必要时降低树事件频率或增大 ring 容量。

## 事件来源

- 写操作：保存文件、创建/更新/删除批注、导入批注、Stitch 生成进度等。
- FS 监听（可选）：
  - 使用 `notify` 监听 `AppState.root`，节流/合并后发出 `tree.changed`、`file.changed`（包含受影响路径列表或目录级别提示）。
  - 防抖建议：200–500ms；批量合并 1s 内事件。
  - 忽略规则：合并 `.gitignore` 与 `.ailoomignore`，仅在沙箱内递归监听；二进制大文件变更不主动读取内容。
  - 事件归一化：绝对路径→root 相对；分隔符统一；Windows 大小写与符号链接谨慎处理（尽量在根内裁剪）。
  - Phase 1：关闭该能力；Phase 2 再开启并压测调参。

## 安全与限制

- 仅监听 `127.0.0.1`（沿用 `main.rs`）；可选 `Origin` 校验，仅允许本地开发域名/端口。
- 限制：
  - 最大连接数（如 100）
  - 单连接最大并发请求（如 32）
  - 单消息体积上限（6MB，与 REST 全文读取硬阈值对齐或更高）
  - 频率限制（读 100 rps、写 10 rps、订阅 10 rps）
  - 广播保护：Hub 广播缓冲有限（如 1024 条）；低优先级事件可被合并或丢弃（向客户端发送 `summary.truncated=true`）。

- 默认阈值建议（首版即可）：
  - `out_tx`（连接级发送缓冲）= 32；`hub` 广播缓冲 = 1024；
  - 连接最大并发请求 = 32；最大连接数 = 100；
- 消息体积上限 = 6MB；超限返回 `MESSAGE_TOO_LARGE` 错误且保留连接，客户端将其视为“可回退 REST”的能力错误（注意：若等价 REST 也触发 `OVER_LIMIT`，则回退同样会失败，错误语义一致）。
  - 读 100 rps、写 10 rps、订阅 10 rps；异常频率可断开（黑名单冷却）。

默认策略（Phase 1）：
- `Origin` 校验：开发模式可关闭；提供开关项，默认仅允许同机端口。
- 启用连接/并发/速率/体积阈值；必要时记录被拒绝/限流指标到 tracing。

## 心跳与清理

- 每 30s 发送 `session.ping` 通知；客户端在 5s 内以“通知”形式回 `session.pong`。若连续 2 个周期未收到 `pong`，关闭连接并清理订阅。
- 重连后：自动重放订阅，并支持（可选）触发 `events.resume`；若 resume 失败或未实现，则主动广播一条 `session.resync` 提示客户端执行粗粒度失效（最小影响范围）。
- Hub 维护连接弱引用，防止泄漏；优雅关闭时广播 `session.shutdown` 并逐步关闭连接。

## 日志与可观测性

- 使用 `tracing`：
  - 连接生命周期日志（open/close/err）
  - 请求耗时（method、id、ok/err、ms）
  - 事件广播计数与丢弃（背压/过滤）

## 回压与丢弃策略

- `out_tx` 设定小缓冲（如 32）；满时对低优先级事件丢弃或合并（`tree.changed` 可合并）。
- 写操作响应与关键事件（如 `file.changed`）尽量不丢弃；必要时退化为“摘要事件”提示客户端主动拉取。

> 提示：`tree.changed` 丢弃/合并应记录被合并/丢弃计数，并在必要时附带 `summary.truncated=true` 供客户端退化为“粗粒度刷新”。

## 通道形态（Hybrid）

- WS 与 REST 并存：读取优先使用 WS；写入默认保留 REST。任一通道的写操作均须触发相同的事件广播（写后广播、一致性优先）。
- 后端业务逻辑尽量抽取为 `services` 纯函数，避免双份实现，保持数据契约一致。

## 伪代码片段（示意）

```rust
// router.rs
.route("/ws", get(ws_upgrade_handler))

// ws::hub
enum Topic { File, Tree, Annotations }
struct Subscription { topic: Topic, filter: Filter, conn_id: usize }
struct Event { method: String, params: serde_json::Value, topic: Topic, key: Option<String> }

// ws::watch（基于 notify）
on_fs_events(batch: Vec<notify::Event>) {
  let merged = coalesce(batch); // 归并/去重/识别移动
  let (file_events, tree_events) = split_by_topic(merged);
  hub.broadcast_many(file_events.map(to_event("file.changed")))?;
  hub.broadcast_many(tree_events.map(to_event("tree.changed")))?;
}

// ws::methods
match method.as_str() {
  "file.getChunk" => { /* 调用 ailoom_fs::read_file_chunk */ }
  "file.save" => { /* 写入 + broadcast file.changed + trigger verify */ }
  "subscribe" => { /* 注册订阅，返回 token */ }
  _ => { /* ... */ }
}
```

## 测试建议

- 单元测试：`methods` 中每个方法的参数校验与错误映射；订阅增删幂等。
- 集成测试：建立多连接、保存文件→接收 `file.changed`、校验完成→接收 `annotations.verify.done`。
- 压测：消息体积上限与并发请求阈值验证；背压下丢弃策略验证。
