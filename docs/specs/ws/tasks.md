# WS 改造实施任务清单（DoR/DoD）

本文是实施前的稳定任务分解，作为“不走偏”的落地对照清单。所有实现与验收均应以本清单 + SSoT（overview/protocol/server/client/migration）为准。

— 概览
- 目标阶段：Phase 1（MVP，读取优先 WS + 写后广播；不启用 FS 监听）
- 出口条件（DoD 汇总）：功能等价、断线重连与回退有效、三段式 Query Key 替换完成、写后广播到位、观测指标可用、默认开关可回退

## Phase 0：基线与一致性（准备）

- [x] 文档冻结（SSoT 同步到位）
  - 对齐本仓 `docs/specs/ws/*` 的路径/限额/Key 口径（已修订）。
  - 验收：变更后的文档不再出现两段式 `['tree', dir]` 或将 `VITE_API_BASE` 误作 root 的示例。

- [x] 前端 Store 扩充 `currentRoot`
  - 文件：packages/web/src/stores/app.ts
  - 内容：新增 `currentRoot: string`（默认等于服务 root），导出 `setCurrentRoot`，与现有 `currentDir` 并存。
  - 验收：能在应用初始化设置 `currentRoot`，并可在多根（未来）场景下切换。

## Phase 1：后端 WS 最小闭环

- [x] 路由与握手
  - 文件：packages/rust/ailoom-server/src/router.rs、src/ws/*（新）
  - 任务：新增 `.route("/ws", get(ws_upgrade_handler))`，握手首帧发送 `session.welcome{ features, limits }`。
  - 验收：浏览器可成功建立 WS 连接并收到欢迎包；`limits.maxMessageBytes/requestTimeoutMs` 存在且为预期值。

- [x] 基础模块骨架
  - 文件：packages/rust/ailoom-server/src/ws/{protocol.rs,conn.rs,hub.rs,methods.rs}
  - 任务：
    - JSON-RPC 编解码与错误映射（沿用 REST 错误码）。
    - 连接读写循环、pending map、`session.ping/pong` 心跳、指数退避关闭（由客户端执行重连）。
    - Hub 维护 topic 索引与定向广播；`eventId` 全局单调。
  - 验收：本地单连接下请求-响应闭环稳定，心跳正常；广播 API 可用（见下一项）。

- [x] 方法与订阅（MVP 范围）
  - methods：`tree.get`、`file.getChunk`、`file.getFull`、`annotations.list`；`subscribe`/`unsubscribe`（topic+filter，幂等 token）。
  - 过滤：`file:{ path|prefix }`、`tree:{ dir }`、`annotations:{ filePath }`。
  - 验收：对等 REST 的数据与错误；重复订阅返回相同 token；退订释放资源。

- [x] 写后广播（REST 注入点）
  - 文件：
    - packages/rust/ailoom-server/src/routes/files.rs（PUT /api/file 成功后）
    - packages/rust/ailoom-server/src/routes/annotations.rs（create/update/delete 成功后）
  - 任务：
    - 成功写文件后广播 `file.changed{ path, kind:'modified', digest }`，随后异步校验，结束后广播 `annotations.verify.done{ ... }`。
    - 批注 CRUD 广播 `annotations.created|updated|deleted`。
    - 所有 `params.path/filePath` 一律 root 相对；广播失败不影响写入事务（记录 tracing）。
  - 验收：前端订阅可收到相应事件；digest 事件优先于监听（监听暂未启用）。

- [x] 安全与限额
  - 绑定回环地址；频率/并发/体积阈值；`Origin` 开关。
  - 验收：超出阈值时返回能力错误（如 `MESSAGE_TOO_LARGE`），连接保留；欢迎包 limits 与实现一致。

- [x] 观测与日志
  - tracing 埋点：连接 open/close、方法耗时、广播计数/丢弃计数。
  - 验收：控制台可观察到上述关键事件与数值。

## Phase 1：前端 WS 最小闭环

- [x] WS 客户端（RxJS）
  - 文件：packages/web/src/lib/ws/{rx-client.ts,singleton.ts}
  - 任务：`call$`、`subscribeTopic$`（自动重订阅）、`notification$`、`online$`、心跳响应（pong）。URL 推导与 `VITE_USE_WS` 开关。
  - 验收：网络断开→`online$` 变更；重连后自动恢复订阅。

- [x] 查询辅助（wsPrefer）与错误归一
  - 文件：packages/web/src/lib/ws/query-helpers.ts
  - 任务：实现“传输/能力错误回退 REST；业务错误不回退”，支持 `AbortSignal` 取消与短窗熔断。
  - 验收：WS 超时/断线/MESSAGE_TOO_LARGE 触发回退；CONFLICT/OVER_LIMIT 不回退。

- [x] 事件→缓存失效（中心化）
  - 文件：packages/web/src/lib/ws/query-invalidator.ts
  - 任务：`file.changed` 精确失效当前文件；`tree.changed` 基于 `impactedPaths` 计算最小目录集合；`annotations.*` 失效或直改缓存；raf 合批。
  - 验收：批量事件一帧内合并；`truncated=true` 时退化为粗粒度刷新当前视图根。

- [x] 订阅挂载（由 UI 状态驱动）
  - 文件：packages/web/src/lib/ws/use-ws-subscriptions.ts
  - 任务：根据 `currentDir/selectedPath/activePane` 维护 `tree/file/annotations` 订阅，仅维持订阅不处理事件。
  - 验收：视图切换自动切换订阅；卸载自动退订。

- [x] 三段式 Query Key 迁移
  - 文件：
    - packages/web/src/features/explorer/pages/explorer-page.tsx（预热与 useIsFetching）
    - 全仓所有 `['tree', currentDir]` 用例（rg 搜索替换，含失效与筛选断言）
  - 任务：统一使用 `['tree', currentRoot, dir]`；在 invalidator/订阅处理中统一注入 `currentRoot`。
  - 验收：仓库不再存在两段式用法；目录树刷新命中精确 Key。

- [ ] API 调用接入 wsPrefer（读取路径）
  - 文件：packages/web/src/features/explorer/api/{tree.ts,files.ts,annotations.ts?}
  - 任务：`tree.get/file.getChunk/file.getFull/annotations.list` 读取优先 WS，失败回退 REST。
  - 验收：在 `VITE_USE_WS=1` 时优先 WS；断线/超时自动使用 REST，不影响交互。

- [ ] UI 兜底与 Debug
  - 任务：提供 `WsBanner`（可选）与 `VITE_WS_DEBUG`（console 级）；不影响功能。
  - 验收：离线时出现轻提示，恢复后消失；DEBUG 打印可控。

## 验收用例（Phase 1 最小闭环）

- [ ] 数据/错误等价：对比 REST 与 WS 的 `tree.get/file.get* / annotations.list` 响应字段与错误码一致。
- [ ] 回退：模拟 `MESSAGE_TOO_LARGE` 或断网 → 读取自动回退 REST；WS 恢复后再次走 WS。
- [ ] 写后广播：保存文件 → 收到 `file.changed(kind:'modified',digest)` 且当前文件缓存被精确失效；校验完成后收到 `annotations.verify.done`；批注 CRUD → 收到对应 `annotations.*` 并刷新。
- [ ] Query Key：仓库内不再存在 `['tree', currentDir]`；预热与筛选按三段式。

## 非目标（Phase 1 不做，但留接口）

- [ ] FS 监听（notify）：模块存在 `ws/watch.rs` 但默认关闭；Phase 2 开启并压测调参。
- [ ] 多连接/registry：保留扩展点，Phase 3 评估。
- [ ] WS 写方法：可选实现；默认仍走 REST。

## Phase 2：事件与订阅拓展（含 FS 监听）

— 范围
- 启用 FS 监听（notify），推送 `tree.changed`（含 summary/impactedPaths）与监听侧 `file.changed`（无 digest）。
- 完整化订阅主题：`annotations.verify.done` 推送；（可选）`stitch.progress`。
- 新增（可选）`events.resume`（增量恢复）。

— 服务端
- [ ] FS 监听器与归一化
  - 文件：packages/rust/ailoom-server/src/ws/watch.rs
  - 任务：`RecommendedWatcher` 优先，回退 `PollWatcher`；仅监听 root；合并 .gitignore/.ailoomignore；路径 root 相对、分隔符统一。
  - 验收：在 `git checkout`/`npm i` 等场景，能捕获事件且路径正确。

- [ ] 合并/节流与上限
  - 任务：防抖 300ms（可配置）、最大合并窗口 ≤ 1s；每批 `impactedPaths` ≤ 200 超出置 `summary.truncated=true`；移动识别（deleted+created 归并为 moved）。
  - 验收：大批量变更不致推送风暴；summary 与计数正确。

- [ ] Hub 增强与丢弃策略
  - 任务：低优先级事件可在背压下合并/丢弃；统计广播/丢弃数；按订阅预过滤（topic+filter）。
  - 验收：out_tx 满时不会拖垮进程；日志可见被合并/丢弃的计数。

- [x] 事件去重与优先级
  - 任务：同一时间窗口，对同路径“写后广播（带 digest）”与“监听事件（无 digest）”去重；优先下发带 digest 的事件。
  - 验收：前端不会因同一路径收到两次刷新。

- [x] 增量恢复（可选）
  - 任务：实现 `events.resume{ after }`，Hub 维护 ring buffer（如 1024）；不足返回 `truncated=true`。
  - 验收：断线后可补齐窗口内事件；不足时客户端退化粗粒度刷新。

— 前端
- [x] 订阅扩展与挂载
  - 任务：在 `use-ws-subscriptions` 中按 UI 状态订阅 `tree:{ dir }` 与 `annotations{}`，必要时订阅 `file:{ prefix }`。
  - 验收：浏览 `currentDir` 时仅接收该目录相关事件；切换时即时切换订阅。

- [x] 中心化失效增强
  - 任务：`tree.changed`：未截断→`calcMinimalDirs(impactedPaths)` 精确失效；截断→失效 `['tree', currentRoot, currentDir]`。`annotations.*` 仍可直改缓存。
  - 验收：大批量事件时 UI 无抖动；渲染次数受控（raf 合批）。

- [x] 监听/写后广播去重（客户端侧）
  - 任务：在 invalidator 内维护“短窗命中表”（如 800ms），同路径若已处理 digest 事件则忽略监听事件。
  - 验收：不会重复 invalidate 同一 Key。

- [ ] 断线补偿（可选）
  - 任务：连接恢复后尝试 `events.resume`，失败或 `truncated=true` 时按粗粒度刷新。
  - 验收：重连窗口内数据与 UI 保持一致。

— 配置与观测
- [x] 开关与阈值
  - 任务：`fsWatch.enabled`、`fsWatch.batchMs`、`fsWatch.maxImpactedPaths`、`fsWatch.maxWindowMs` 等；前端 `VITE_WS_DEBUG` 扩展打印事件摘要。
  - 验收：可通过环境变量或配置调整阈值；DEBUG 输出可控。

- [ ] 压测/回归
  - 任务：脚本模拟 1k+ 文件改动；统计广播/丢弃/渲染次数；确认 CPU/内存稳定。
  - 验收：在典型仓库上不出现“UI 风暴”，指标在预算内。

## 验收用例（Phase 2）

- [ ] `git checkout`/批量写入触发 `tree.changed`，未截断时按最小目录集合精确刷新；截断时粗粒度刷新当前视图根。
- [ ] 保存文件与监听同时命中同一路径，仅触发一次有效刷新（digest 事件优先）。
- [ ] 重连后 `events.resume` 可补齐；不足时退化策略生效。

## Phase 3：Hybrid 完整化（WS 主 + REST 保留）

— 范围
- WS：在保持 REST 作为长期保留与兜底的前提下，补齐可选写方法（与 REST 完全等价），完善订阅主题与能力协商；引入多连接/registry 支撑按域拆分（默认仍为 `default` 单连接）。
- REST：保留 `PUT /api/file`、`POST/PUT/DELETE /api/annotations/*`、导入/导出/校验、`/api/stitch` 等；读取端点继续作为兜底与脚本入口。

— 服务端
- [x] WS 写方法（等价性）
  - 任务：实现 `file.save` 与（可选）`annotations.create|update|delete|import|export|verify` 的 WS 版本；入参/返回/错误与 REST 等价，冲突仍返回 `CONFLICT`。
  - 广播：成功写后仍广播相同事件（与 REST 路由写后广播一致）。
  - 验收：同一用例下 WS 写与 REST 写的响应与副作用一致；重复提交幂等策略与 REST 相同。

- [ ] 多连接/registry 与 QoS（可选）
  - 任务：在 Hub/conn 层支持连接命名与限额隔离；按 topic 归类优先级：写应答与 `file.changed(digest)` > `annotations.*` > `tree.changed`。
  - 验收：低优先级在背压下被合并/丢弃时，关键路径不受影响；统计可观测。

- [x] 能力协商与信息接口
  - 任务：`session.info/health`（可选）返回 serverVersion、features、limits 概览；欢迎包 features 与实际实现一致。
  - 验收：前端可据此显示/诊断，功能开关与 features 对齐。

- [ ] 安全与限额复核
  - 任务：按域/连接的频率与并发限制；Origin 白名单；异常频率断开冷却。
  - 验收：压测下限额生效，日志可见拒绝/限流原因。

— 前端
- [ ] registry/factory 与连接路由（可选）
  - 文件：packages/web/src/lib/ws/registry.ts（或合并到 singleton 实现）
  - 任务：`ensure(name,cfg) / get(name) / release(name)`；`routeTopic(methodOrTopic)` 缺省返回 `default`，预留将来按域（如 `stitch`）拆分连接。
  - 验收：默认单连接不变；配置第二连接时可独立重连/熔断，不影响默认连接。

- [x] 写路径策略与开关
  - 任务：默认写仍走 REST；在开发/实验开关下允许走 WS 写（如 `VITE_WS_WRITE=1`），同时保留重试/冲突提示逻辑。
  - 验收：开关关闭时行为与 Phase 1 相同；开启时 WS 写与 REST 写等价，无重复提交与双写副作用。

- [ ] 订阅与同步增强（可选）
  - 任务：可引入“聚合 topic（如 query-sync）”以直接下发失效/补丁；保持默认策略为“事件触发 invalidate”。
  - 验收：在聚合通道开启时，关键列表/详情可减少一次拉取；关闭后仍完全可用。

— 观测与压测
- [ ] 端到端基准
  - 任务：比较 REST-only、WS 读取 + REST 写、WS 读取 + WS 写 三种模式下的首屏、分页与保存延迟；记录 CPU/内存。
  - 验收：Phase 3 不劣于 Phase 1/2；关键路径无退化。

## 验收用例（Phase 3）

- [ ] WS 写方法与 REST 等价：相同请求体/相同错误码（CONFLICT/OVER_LIMIT/INVALID_PATH），事件广播一致。
- [ ] 多连接稳定性：在 `default` 与另一连接（如 `fs`）同时存在时，单个连接 down 不影响另一个；重连后订阅恢复各自独立。
- [ ] QoS：在广播风暴压测下，`file.changed(digest)` 与写应答不丢失；`tree.changed` 可被合并/丢弃并产生 summary。
- [ ] 开关：`VITE_WS_WRITE=0/1` 切换写入通道不影响业务正确性。

## Phase 4：优化与扩展（性能/协议/可观测性）

— 范围
- 大消息优化：分片/流式、MessagePack 编解码、批量请求（可选）。
- 可观测性完善：端到端指标、事件面板、限流与丢弃原因可视化。
- 回压与稳定性：更细粒度的背压策略、优先级队列与丢弃策略参数化。

— 服务端
- [ ] 分片/流式传输（可选）
  - 任务：新增 `file.readStream`（返回 `streamId`），随后 `stream.next` 迭代下发块；或在 JSON-RPC 内支持多帧/续传。
  - 验收：对超大文本，首屏时间与内存峰值显著好于 `file.getFull` 单帧；中断与取消可控。

- [ ] MessagePack 编解码（可选）
  - 任务：在握手 features 协商 `['msgpack']`；服务端支持 msgpack 帧收发；客户端可选择开启。
  - 验收：在大 payload 下 CPU 开销与带宽均优于 JSON；兼容 JSON 回退。

- [ ] 批量请求（可选）
  - 任务：支持单帧 `[{id,method,params},...]` 的批处理与速率限制；应答可乱序但按 id 匹配。
  - 验收：高延迟链路下总体 RTT 降低；限流与拒绝策略生效。

- [ ] 背压/优先级细化
  - 任务：按 topic/方法设定优先级与队列上限；关键事件（写应答、file.changed(digest)）绝不丢弃；低优先级（tree.changed）合并/丢弃。
  - 验收：压力测试下关键路径无回退；丢弃统计清晰。

- [ ] 可观测性与日志扩展
  - 任务：导出 Prometheus 指标或结构化统计（连接数、pending、广播/丢弃计数、队列长度、方法耗时分布）。
  - 验收：Grafana/日志可视化能定位瓶颈与异常。

— 前端
- [ ] 流式消费能力（可选）
  - 任务：为超大文件阅读/预览提供流式 UI（分块追加、滚动增量加载）。
  - 验收：超大文件体验优于非流式；取消/错误处理稳定。

- [ ] MessagePack 客户端（可选）
  - 任务：在 ws 客户端增加 msgpack 编解码适配；feature 协商失败回退 JSON。
  - 验收：与服务端 msgpack 对齐；兼容回退路径完整。

- [ ] 批量请求封装（可选）
  - 任务：提供 `batchCall([{method,params}], opts)`；内部匹配响应 id；失败半成功可处理。
  - 验收：高延迟环境下加载多个资源的总体耗时下降。

- [ ] 端到端观测
  - 任务：在调试模式下暴露 WS 状态面板（连接状态、订阅、事件速率、丢弃数）。
  - 验收：问题复现与定位效率提升。

— 压测与回归
- [ ] 大仓库/海量事件/弱网延迟/丢包场景基准
  - 验收：关键交互不退化；回压策略生效；吞吐与延迟在预算内。

## 验收用例（Phase 4）

- [ ] 流式/分片：大文件读取首屏时间显著缩短（相对单帧）；可取消。
- [ ] MessagePack：在相同数据量下带宽/CPU 开销下降，JSON 回退可用。
- [ ] 批量请求：多个读取请求总体耗时下降；速率限制/拒绝策略生效。
- [ ] 观测：面板与指标能反映队列长度、丢弃与耗时分布；可定位热点。


## 质量门禁（Quality Gates）

- [ ] 性能：批量失效合批；消息大小/并发/速率限额生效；首屏无明显回退。
- [ ] 安全：仍仅回环监听；路径沙箱/非文本限制/写入冲突保持有效。
- [ ] 可回退：`VITE_USE_WS=0` 全面使用 REST；`VITE_USE_WS=1` 但 WS down 时透明回退。
- [ ] 可观测：tracing 关键日志齐备；前端可观测 `online$` 与最小调试输出。

## 路障与依赖（Blockers）

- Dev 代理需正确透传 Upgrade（Vite 已配置 `/ws`，需本地验证）。
- 大仓库/大消息场景的体积阈值需与 REST 对齐（`maxMessageBytes ≥ 6MB`）。

## 交付物（Deliverables）

- 代码变更：server `src/ws/*` 与 REST 写后广播；web `src/lib/ws/*` + 三段式 Key 迁移。
- 验收记录：上述“验收用例”逐项截图/日志；关键配置与开关说明。
- 回滚方案：一键关闭（`VITE_USE_WS=0`）验证通过。

---

## 测试清单（建议选型与目标，仅文档）

说明：遵循“单元优先、集成兜底、必要时 E2E 验收”的策略；不强制覆盖率门槛，但要求关键路径可回归。执行时，用户仅需后台运行 `just dev-all`；单元/集成测试尽量进程内运行，无需外部端口；E2E 依赖 dev-all 提供本地服务。

— 服务端（Rust, Axum）
- 单元测试（mod tests）
  - `ws::protocol`：JSON-RPC 编解码与错误映射；错误码等价（`INVALID_PATH/NON_TEXT/OVER_LIMIT/...`）。
  - `ws::hub`：`subscribe/unsubscribe` 幂等、过滤命中、同 key 保序；队列满时丢弃/合并计数统计。
  - `ws::methods`：`tree.get/file.getChunk/file.getFull/annotations.list` 参数校验与错误分支；限额触发 `MESSAGE_TOO_LARGE`。
- 集成测试（tests/，进程内启动 Router）
  - `/ws` 握手 → 首帧 `session.welcome{ features, limits }`。
  - RPC 等价：`tree.get/file.get* / annotations.list` 返回与 REST 对齐（字段/错误码）。
  - 写后广播：调用 `PUT /api/file` → 收到 `file.changed(digest)`；校验结束 → `annotations.verify.done`。
  - 大消息：构造超限文件 → WS 返回 `MESSAGE_TOO_LARGE`，REST 返回 413 + `OVER_LIMIT`。
  - Phase 2：模拟 notify 事件 → `tree.changed`（未截断与 `summary.truncated=true`）。
  - 可选：`events.resume{after}` ring-buffer 增量；不足时 `truncated=true`。

— 前端（Vitest/RTL/RxJS）
- 单元测试（Vitest）
  - `wsPrefer`：传输/能力错误（断线、超时、`MESSAGE_TOO_LARGE`）回退 REST；业务错误（`INVALID_PATH/OVER_LIMIT/...`）不回退；支持 AbortSignal 取消；短窗熔断门槛。
  - `query-invalidator`：`calcMinimalDirs` 正确性；`tree.changed` 未截断精确失效、截断粗粒度失效；raf 合批去重。
  - `use-ws-subscriptions`：基于 `currentDir/selectedPath/activePane` 的订阅重建与退订。
  - Rx 客户端：`subscribeTopic$` 自动重订阅；`session.ping/pong` 处理；`online$` 状态切换。
- 集成测试（Vitest + msw/ws-mock）
  - 模拟 WS 方法与推送，验证 TanStack Query 的 `invalidateQueries/setQueryData` 联动。
  - 三段式 `['tree', root, dir]` 在预热/useIsFetching/失效中的一致性。
  - 批注事件 `annotations.*` 直改缓存与列表合并去重。

— E2E 验收脚本（Node/脚本，依赖 dev-all）
- 读取 `AILOOM_PORT`，对接真实后端：
  - 握手 `/ws`、RPC 等价、订阅与写后广播、`MESSAGE_TOO_LARGE` 回退路径。
  - 目录树 Key 与失效：触发 `tree.changed`（可用 mock/预置文件），观察精确/粗粒度刷新。
- 报告：输出每条断言通过/失败与关键日志片段。

— 门禁（建议）
- 单元：关键函数/模块具备最小断言集合；
- 集成：WS 与 REST 等价性至少覆盖 tree/file/annotations 基线；
- E2E：最小闭环（握手/调用/订阅/写后广播/回退）全绿；
- 失败即回归修复，不积压到后期。
