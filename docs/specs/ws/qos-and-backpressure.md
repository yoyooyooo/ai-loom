# 回压与 QoS（优先级与丢弃策略，建议稿）

目标：在高负载、弱网或批量文件变更等压力场景下，保证关键链路“先到、不丢、可预期”，同时对次要事件执行“合并/降级/可丢弃”，以维持整体交互稳定。

## 术语

- QoS（Quality of Service）：按重要性为不同类型消息配置优先级、缓冲与丢弃策略。
- 回压（Backpressure）：当下游处理/网络发送能力不足时，对上游施加限制（排队/丢弃/合并/拒绝）。

## 优先级模型（Topic/Method 建议）

优先级从高到低：
1) 写应答（`file.save` 结果）与关键事件（`file.changed` 含 `digest`）
2) 批注变更（`annotations.created|updated|deleted`）与校验完成（`annotations.verify.done`）
3) 目录树变更（`tree.changed`）与无 `digest` 的监听侧 `file.changed`

说明：
- 级别 1（关键）：“绝不丢弃”；仅在极端情况下退化为“摘要+提示”由客户端主动拉取。
- 级别 2（重要）：尽量不丢；可轻度合并或延迟，不能长期堆积。
- 级别 3（可合并/可丢）：允许窗口内合并；超额时可丢弃并在 `summary.truncated=true` 的事件中提示客户端粗粒度刷新。

## 队列与阈值（建议参数）

- 连接级发送缓冲（`out_tx`）：小缓冲（如 32）。
- Hub 广播 ring-buffer（事件 resume 用）：如 1024（可配置）。
- 监听合并窗口：防抖 300ms、最大合并 1s；`impactedPaths` 上限 200。
- 速率限制：读 100 rps、写 10 rps、订阅 10 rps（服务端实现可调整）。

以上参数通过 `session.welcome.params.limits` 对外公布，具体数值以实现为准。

## 丢弃/合并策略

- `tree.changed`：可合并与丢弃（记录被合并/丢弃计数），超限用 `summary.truncated=true` 并省略 `impactedPaths`；客户端据此执行粗粒度刷新当前视图根。
- 监听侧 `file.changed`（无 digest）：若同窗口内存在同路径的“写后广播（含 digest）”，则监听事件降级/丢弃（或标记 `reduced=true`）。
- 写应答与“含 digest 的 file.changed”：不丢弃；必要时降级为“摘要+提示”引导客户端主动拉取。

## 顺序与幂等

- 保序范围：同 topic 同 key（如同一 `path`）尽量保持有序。
- 幂等：客户端以 `version/digest/ts` 与 `eventId` 做去重与回退保护；较新的版本覆盖旧版本。

## 观测与指标（建议）

导出以下指标（Prometheus/日志聚合均可）：
- 连接：打开/关闭次数、在线连接数、重连次数、心跳往返耗时分布。
- 请求：按 method 的 QPS、P50/P95/P99 耗时、错误率（code 分类）。
- 广播：按 topic 的发送计数、被合并计数、丢弃计数、平均事件大小、队列长度分布。
- 回退：`MESSAGE_TOO_LARGE`、解析失败、发送失败、超时等传输类错误计数。

UI/调试（可选）：
- 提供前端 WS 状态面板：显示 `online`、订阅列表、事件速率、丢弃/合并计数摘要。

## SLO/SLA（建议目标）

- 保存应答（`file.save`）与 `file.changed(digest)` 首个到达：本地机器上 P95 ≤ 200ms。
- 目录树大批量刷新：在 1 秒的处理/合并窗口内完成一次稳定刷新；UI 不应出现明显抖动。
- 弱网（RTT>200ms）下：关键链路（级别 1/2）不丢；级别 3 合并/丢弃率在可接受阈值内（例如 ≤ 10%，且始终伴随 `summary.truncated` 提示）。

## 配置（建议命名）

- 服务端（示例）：
  - `ws.limits.maxMessageBytes`
  - `ws.limits.maxConcurrentRequests`
  - `ws.rate.readRps / ws.rate.writeRps / ws.rate.subRps`
  - `ws.outbox.capacity`（连接级 out_tx）
  - `ws.hub.bufferSize`（resume ring-buffer）
  - `fsWatch.enabled / fsWatch.batchMs / fsWatch.maxWindowMs / fsWatch.maxImpactedPaths`

- 前端（Vite 环境变量）：
  - `VITE_USE_WS=0|1`、`VITE_WS_URL`、`VITE_WS_WRITE=0|1`、`VITE_WS_DEBUG=0|1`

## 验收要点

- QoS 生效：压测风暴下，关键事件无丢失；低优先级事件统计出现合并/丢弃且 UI 仍可接受。
- 指标可用：能从日志/监控面板中读出丢弃原因与热点 topic/method。
- 回退链路：消息超限/解析失败/发送失败/断线时，前端读取回退 REST 生效；业务错误不回退。

