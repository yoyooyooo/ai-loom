# 风险与待决策清单（初稿）

## 主要风险

- 断线与幂等
  - 重连窗口的重复提交/重复响应；订阅恢复遗漏事件
- 大消息与内存
  - `file.getFull`、`annotations.export` 等超帧；广播风暴导致内存/CPU 峰值
- 一致性与竞态
  - 多客户端并发写导致冲突；推送到达顺序与本地缓存回写先后不一致
- 浏览器与代理限制
  - Dev 代理未正确透传 WS Upgrade；本地安全策略限制 WS
- 可观测性不足
  - WS 缺乏 HTTP 级的可视化与日志，需要额外埋点
- 资源清理
  - 长连接/订阅泄漏；背压队列堆积
 - 监听风暴
   - 大型仓库批量改动、切分支/拉代码导致的高频 FS 事件，可能压垮广播与前端刷新

## 风险缓解

- 客户端
  - 请求超时与去重（按 `id`）；断线自动重连 + 订阅恢复
  - 推送携带 `ts/version`，前端以“版本新鲜度”避免状态回退
- 服务端
  - 有界队列 + 丢弃/合并低优先级事件（`tree.changed` 可合并）
  - 写路径严格 `CONFLICT`；必要时引入 `etag`/`digest` 对比
  - 连接/消息/速率限制；`Origin` 校验
  - tracing 埋点（连接、请求、广播、丢弃）
  - FS 监听事件合并（200–500ms）与上限（例如每次最多 200 path；超出仅发送 summary）

## 需要决策的细节（含已决策项）

- 协议与路径（已决策）
  - WS 路径：`/ws`
  - 编解码：JSON（首版不引入 MessagePack/流式）
  - 心跳：`session.ping`/`session.pong` 均为“通知”，不要求响应，简化实现
- 订阅模型（已决策）
  - 显式 `subscribe/unsubscribe`
  - 主题粒度：`file`/`tree`/`annotations`；过滤支持 `file:{ path|prefix }`、`tree:{ dir }`、`annotations:{ filePath }`
  - 仅支持“主题 + 过滤”的订阅；不提供“按任意方法名”订阅。全局低频通知仅 `session.*`。
  - 前端 API：`subscribeTopic$(topic, filter) => Observable<{ method, params }>`（返回包含子方法名以区分 created/updated/deleted）。
  - 订阅 token 幂等：`token = hash(topic + stable(filter))`，其中 `stable(filter)` 为“键名排序的 JSON 字符串”（剔除空/缺省字段），确保不同字段顺序/版本序列化一致得到同一 token。
- 推送范围与策略（建议默认）
  - `tree.changed`：目录级 + `impactedPaths`（最多 200，超出以 `summary.truncated=true` 退化）
  - 丢弃与合并：维持小缓冲 + 合并低优先级事件（如 `tree.changed`），防抖/批量策略见 server 实现。具体数值以 `protocol.md` 的限额与实现默认为准。
  - 消息体积：上限与超限语义参见 `protocol.md`（由 `session.welcome.limits.maxMessageBytes` 公布）。当 WS 返回 `MESSAGE_TOO_LARGE` 时前端回退 REST（若 REST 亦返回 `OVER_LIMIT`，则直接按 REST 错误提示）。
  - 事件语义：推送包含 `eventId`（Hub 级单调序号）与 `version`（资源级版本/etag）；`file.changed.version` 优先使用 `digest`。
- 并存策略（已决策：Hybrid）
  - 最终形态为“WS 主导实时 + REST 保留简单 CRUD/工具型”，长期共存；CLI/桌面/脚本可直接使用 REST。
- 安全策略
  - `Origin` 校验默认：开发模式可关闭（仅允许本机端口），生产构建建议开启；最大连接/消息上限；黑名单（异常频率断开）
 - 过滤能力
   - `file.prefix` 是否作为首版能力；`annotations.filePath` 的筛选是否默认开启
 - 事件载荷（已决策）
 - `file.changed`：仅“写成功”路径附带 `digest`；FS 监听推送不计算 `digest`
  - 当同窗口内既有“写后广播（带 digest）”又有监听事件，客户端以带 `digest` 的事件为准，监听事件可忽略

- 前端 API 与状态（已决策）
  - `ws.enabled: boolean`（由 `VITE_USE_WS` 控制）；
  - `ws.online$: Observable<boolean>`（连接在线状态，供 Banner/UI 使用）。
  - `ws.state: 'up'|'down'|'connecting'`（对 UI 与熔断逻辑开放）。
  - `wsPrefer`：可回退错误集合为“连接未建立/断线、请求超时、发送失败、解析失败、MESSAGE_TOO_LARGE”，默认 15s 超时；实现短窗熔断（例如 10s 优先 REST 并周期性 WS 探测）。

— Query Key 口径（已决策）
- 目录树统一使用三段式 `['tree', root, dir]`（顶层 `dir='.'`）；页面预热与组件层保持一致，避免缓存歧义。

— Stitch 进度推送（阶段性）
- `stitch.progress` 推送留待 Phase 2；Phase 1 为一次性返回，不做进度事件。

## 开放问题（Open Questions）

- 是否引入 `session.health`/`session.info` 方法，便于前端冷启动自检与能力协商？
- `stitch.progress` 是否需要分阶段推送，或一次性返回满足需求？
- 是否需要前端在编辑器内做更细的冲突提示与自动合并？
 - 是否需要提供“批量变更摘要”专用事件，以降低大规模变更时的 UI 抖动？
