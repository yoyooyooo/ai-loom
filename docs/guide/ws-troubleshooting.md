# WS 问题排查速查表

本速查表用于快速定位 WebSocket 读写、事件订阅与广播链路的问题，覆盖本地开发与打包后的基本场景。

## 目标与范围
- 核对“读取优先 WS、短窗熔断回退 REST；写入默认 REST（可开关 WS）”是否生效
- 校验 Explorer（file/tree/annotations）与 Codex（chat.*）的事件互不干扰
- 定位 WS 连接、订阅、广播、恢复（events.resume）与 UI 失效器的问题

## 快速定位流程（5 分钟）
1) 打开调试与路由打印：`VITE_WS_DEBUG=1 VITE_WS_DEBUG_ROUTE=1`
   - 观察面板右上角 `WS: online (up)`；控制台出现 `[wsPrefer] WS ...`/`REST(fuse)` 日志
2) 纯 WS 读取验证：`VITE_WS_NO_FALLBACK=1 VITE_WS_FUSE_MS=0`
   - 访问文件树/打开文件/加载注解列表，应全部走 WS；若连接未就绪，`wsPrefer` 会短等 1s 再发首批请求
3) 写入路径验证（默认 REST）：编辑并保存→应看到 REST 调用；如需走 WS：再加 `VITE_WS_WRITE=1`
4) 文件监听：后端 `AILOOM_FSWATCH_ENABLED=1`，修改受管文件→面板 `fileChanged` 递增，UI 自动刷新
5) 断线恢复：刷新页面并在 `.env.local` 设置 `VITE_WS_RESUME=1`，观察断线补发仅包含 `file/tree/annotations`，不重播 `chat.*`

## 常见症状 → 可能原因 → 快速验证 → 处置建议
- 无法连接 WS（面板 offline/connecting）
  - 原因：后端未启动/跨域/URL 推导错误
  - 验证：浏览器 Network 里 `/ws` 是否 101；或设置 `VITE_WS_URL=ws://127.0.0.1:<port>/ws`
  - 建议：确认后端 `ws_upgrade_handler` 端口/Origin，必要时 `AILOOM_WS_ALLOW_ANY_ORIGIN=1`

- 读取总是走 REST（控制台频繁 `REST(fuse)`）
  - 原因：上次 WS 调用传输/能力错误触发短窗熔断
  - 验证：开启 `VITE_WS_DEBUG_ROUTE=1`，查看错误码是否 `TIMEOUT/WS_DOWN/MESSAGE_TOO_LARGE/NOT_SUPPORTED`
  - 建议：排除网络/超时；若要强制验证 WS，设 `VITE_WS_NO_FALLBACK=1`

- 保存后 UI 不刷新或延迟
  - 原因：事件丢失/延迟、面板订阅异常、前端去重窗口命中
  - 验证：面板 `broadcasts/fileChanged` 是否增长；查看 `ws-invalidators` 订阅是否被触发
  - 建议：开发期可设 `AILOOM_WS_EAGER_SAVE_ECHO=1` 兜底；检查前端 `DEDUP_WINDOW_MS(800ms)` 是否影响感知

- `tree.changed` 很多但界面不更新细粒度
  - 原因：`impactedPaths` 超限被截断（`truncated: true`）
  - 验证：面板 stats 的 `tree.truncatedBatches` 是否增长
  - 建议：前端已回退为当前根目录粗粒度刷新；如需更细，调整 `AILOOM_FSWATCH_MAX_IMPACTED`

- 刷新后对话历史被重复播放
  - 原因：客户端误将 `chat.*` 纳入 resume 序列
  - 验证：控制台是否打印 `chat.*` 在 resume 列表中
  - 建议：确保前端仅对 `file/tree/annotations` 推进 `lastEventId`，`chat.*` 单独去重（代码已内置）

## 关键环境变量
- 前端：
  - `VITE_WS_DEBUG` 打开调试面板
  - `VITE_WS_DEBUG_ROUTE` 打印 WS/REST 路由决策
  - `VITE_WS_NO_FALLBACK` 纯 WS 读取验证（不回退）
  - `VITE_WS_FUSE_MS` 熔断窗口（默认 1500ms）
  - `VITE_WS_TIMEOUT_MS` WS 请求超时（默认 15000ms）
  - `VITE_WS_WRITE` 保存走 WS（默认写入 REST）
  - `VITE_WS_RESUME` 启用事件补发可视化验证
  - `VITE_WS_URL` 覆盖 WS 连接地址
- 后端：
  - `AILOOM_FSWATCH_ENABLED` 启用文件监听
  - `AILOOM_WS_DEDUP_MS` `file.changed` 去重窗口（默认 200ms）
  - `AILOOM_WS_ALLOW_ANY_ORIGIN` 允许任意 Origin（默认 1）
  - `AILOOM_FSWATCH_MAX_IMPACTED` 树摘要的受影响路径上限
  - `AILOOM_WS_TRACE_BROADCAST` 打印广播明细
  - `AILOOM_WS_EAGER_SAVE_ECHO` 保存后即时瞬时广播一次 `file.changed`

## 常见错误码对照
- `TIMEOUT`：WS 请求超时；提高 `VITE_WS_TIMEOUT_MS` 或检查后端处理耗时
- `WS_DOWN`：尚未就绪或断线；等待 `online` 变为 true 再发起调用
- `MESSAGE_TOO_LARGE`：载荷过大（例如全文过大）；使用分块接口或走 REST 并分页
- `NOT_SUPPORTED`：服务端缺少能力（如 hub 未初始化）；检查后端启动日志
- `CONFLICT:...`：保存冲突（digest 不匹配）；刷新文件后重试或触发合并

## 采集诊断信息（提交工单/Issue 建议附带）
- 前端：
  - 调试面板“复制快照”输出
  - 控制台路由日志（`[wsPrefer]`）与错误堆栈
- 后端：
  - 服务端日志（`ws`、`fswatch`、`codex` 等 target）
  - 关键环境变量与版本（面板 `session.info` 已含）

## FAQ
- Q: WS 与 REST 是否会打架？
  - A: 读取路径有熔断回退，写入默认 REST；事件命名空间隔离（`file/tree/annotations` vs `chat.*`），不会相互覆盖或串流。
- Q: 如何验证 Explorer 与 Codex 互不影响？
  - A: 面板类型计数中 `file/tree/ann` 与 `chat.*` 分别增长；前端订阅处理只匹配对应前缀的方法名。

