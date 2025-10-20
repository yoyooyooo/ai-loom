# 自动化说明（极简）

- 用户只需在仓库根后台运行：`just dev-all`。
- 代理（LLM）按 `docs/specs/ws/tasks.md` 的阶段任务自行修改代码与自检，不需要你干预服务启停。

## 运行与开关（本地）

- WS 读取默认开启：无需设置 `VITE_USE_WS`；若需禁用请显式设置 `VITE_USE_WS=0`。调试输出：`VITE_WS_DEBUG=1`（显示 WS 面板、事件摘要、服务器统计）。
- 启用 WS 写入（可选，等价 REST）：`VITE_WS_WRITE=1`（默认关闭，仍走 REST）。
- 启用 FS 监听（可选，Phase 2）：`AILOOM_FSWATCH_ENABLED=1`；阈值/忽略：
  - `AILOOM_FSWATCH_BATCH_MS`（默认 300）
  - `AILOOM_FSWATCH_MAX_WINDOW_MS`（默认 1000）
  - `AILOOM_FSWATCH_MAX_IMPACTED`（默认 200）
  - `AILOOM_FSWATCH_IGNORE_VCS=1`、`AILOOM_FSWATCH_IGNORE_AILOOM=1` 合并 `.gitignore` 与 `.ailoomignore`
- Origin 限制（可选）：`AILOOM_WS_ALLOW_ANY_ORIGIN=0` + `AILOOM_WS_ALLOWED_ORIGINS='http://127.0.0.1:5173,...'`

## 观测与健康

- 欢迎包：`session.welcome` 携带 `limits.maxMessageBytes/requestTimeoutMs` 与 features。
- 信息接口：`session.info` 返回 `serverVersion`、`features`、`limits`、`stats`（Hub 快照）。
- 周期统计推送：`session.stats`（2s 一次）包含 ring 大小/容量、最近 eventId、广播计数/错误/无订阅、低优先丢弃数、file/tree 累计指标。
- 前端面板（`VITE_WS_DEBUG=1`）：显示在线状态、events/s 小图、当前订阅主题列表、服务器统计与 RTT 采样；并可查看最近周期的 `treeChangedBatches/droppedRingLowpri/broadcasts` 增量趋势与 `session.resync` 次数（断线后增量不足时触发）。

## 测试（后端/前端）

- 后端（默认）：`cargo test -p ailoom-server --tests`（握手/RPC/广播/resume/ws 写 用例均覆盖）。
- FS 监听测试：默认忽略（平台差异）；手动启用：
  - `AILOOM_FSWATCH_ENABLED=1 cargo test -p ailoom-server --test ws_fs_watch -- --ignored --nocapture`
- 前端单测：`pnpm -C packages/web test`（wsPrefer 回退、invalidator 合批/去重/最小目录/直改、use-ws-subscriptions 订阅重建/清理）。

## 恢复与回退

- WS 断线：客户端自动重连 + 重订阅，并先尝试 `events.resume{ after }` 增量补偿；失败或 `truncated=true` 时广播 `session.resync`，前端粗粒度刷新当前视图根。
- 全局回退：`VITE_USE_WS=0` → 只用 REST；WS down/超时/能力不足（`MESSAGE_TOO_LARGE`）自动回退 REST 读取。
## 压测/回归建议

- 启用监听：`AILOOM_FSWATCH_ENABLED=1`
- 快速模拟 1k 文件变更：`scripts/fs-burst.sh . 1000`
  - 预期：前端面板中 `treeChangedBatches` 与 `broadcasts` 增量出现尖峰；`droppedRingLowpri` 在 ring 容量不足时增加；UI 端目录树刷新不应出现明显风暴（invalidator 合批/最小目录集合生效）。
- WS 写压测：以 10~50 QPS 调用 `file.save`（建议写在 `tmp-burst` 下），观察 `fileChangedTotal` 增量与 RTT；冲突情况下应返回 `CONFLICT` 并保持等价行为。
- 断线恢复：人为断开网络/停后端几秒→重连→`events.resume` 补发；不足时面板出现 `session.resync` 触发的粗粒度刷新。
- HTTP 写压测（REST 基线）：`node scripts/save-burst.mjs <port> <count> <concurrency>`（默认 `port=AILOOM_PORT`，`count=200`，`concurrency=16`）
  - 示例：`AILOOM_PORT=3000 node scripts/save-burst.mjs 3000 500 32`
  - 预期：面板 `broadcasts` 增量上升、`fileChangedTotal` 累加增长；RTT 与 p50/p90/p99 打印在脚本输出中。
