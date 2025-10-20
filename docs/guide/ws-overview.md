# WS 总览与调试面板指南

本指南覆盖 WS 架构要点与调试面板用法。既可作为“WS 技术细节说明”，也提供一套可操作的验证/排障方法，帮助判断 WS/订阅/监听/转发是否正常。

## 开启方式与前提

- 开启面板：在启动命令前加环境变量 `VITE_WS_DEBUG=1`
  - 例：`VITE_WS_DEBUG=1 just dev-all`
  - 例（纯 WS 验证）：`VITE_WS_DEBUG=1 just dev-all-ws`
- 位置：浏览器右下角浮动面板（仅在 `VITE_WS_DEBUG=1` 时显示）。
- 与 WS 相关的常用开关（按需叠加）：
  - `VITE_WS_DEBUG_ROUTE=1`：控制台打印 WS/REST 路由选择
  - `VITE_USE_WS=1`：启用 WS（默认已启用）
  - `VITE_WS_NO_FALLBACK=1`：禁用回退（用于纯 WS 读取验证）
  - `VITE_WS_FUSE_MS=0`：关闭短窗熔断（与 no-fallback 搭配）
  - `VITE_WS_WRITE=1`：保存（写入）走 WS 的 `file.save`
  - `VITE_DISABLE_VERIFY=1`：关闭编辑器首帧的注解校验 REST 调用
  - `AILOOM_FSWATCH_ENABLED=1`：后端开启本地文件监听（影响 `file.changed`/`tree.changed`）
  - `AILOOM_WS_EAGER_SAVE_ECHO=1`：开发兜底，`file.save` 成功后立刻额外广播一次瞬时 `file.changed`（不入 ring），确保“保存即见”。

## 面板结构与交互

- 顶部状态与控制
  - `WS: online/offline (state)`：当前 WS 在线状态与内部状态（`up/connecting/down`）
  - `暂停`：暂停采样与统计更新；再次点击恢复
  - `收起/展开`：折叠/展开面板详细信息
  - `复制快照`：复制一次包含 `session.info` 与最新 `session.stats` 的 JSON，便于粘贴到工单/聊天

- 速率与订阅
  - `events/s`：每秒收到的 WS 事件数
  - `file/tree/ann`：每秒三类事件数（`file.changed`、`tree.changed`、`annotations.*`）
  - `subs`：当前订阅主题及过滤条件；暂停时会冻结为最近一次订阅快照

- 统计快照（来自服务端 `session.stats` 通知，默认 2s 一次）
  - `stats.ts`：服务端产生该快照的时间戳（RFC3339）
  - `server, features`：服务端版本与启用的功能（如 `fswatch`）
  - `ring: ringSize/ringCap`：事件环当前长度与容量（右侧带颜色条：绿/橙/红）
  - `lastEventId`：最新事件 ID（用于断线后增量 `events.resume`）
  - `broadcasts: total (err:x noRecv:y)`：服务端广播总数、失败数（一般为连接关闭瞬间写失败）、无订阅者接收次数
  - `droppedLowPri`：低优先级事件（树摘要）因容量压力被丢弃的累计数
  - `fileChanged`：累计文件变更事件数（保存/监听）
  - `tree: batches/impacted/moved/truncated`：目录层面的合批次数、累计受影响路径、移动次数、是否出现“摘要被截断”的批次数
  - 小图（三条）：展示最近 10 个周期内 `tree.batches/droppedLowPri/broadcasts` 的增量趋势

- RTT（Round Trip Time）
  - 面板每 5 秒对 `session.info` 做一次请求/响应往返，用以估算客户端↔服务端的 WS 往返时延
  - 含义：仅反映面板采样时的轻量请求耗时；不等同于网络层 RTT，也不代表所有业务请求的耗时
  - 本地开发常见范围：3–15ms；异常抖动可结合 `events/s` 与服务端日志排查

## 常见验证路径

1) 读取与订阅（纯 WS）
   - 启动：`VITE_WS_DEBUG=1 just dev-all-ws`
   - 预期：控制台出现 `[wsPrefer] WS tree.get/file.getChunk/annotations.list`；面板显示 `WS: online (up)`，且 `events/s`、小图有跳动

2) 写入（保存）走 WS
   - 启动：`VITE_WS_WRITE=1 VITE_WS_DEBUG=1 just dev-all-ws`
   - 预期：保存后 WS Frames 有 `file.save` 请求/响应；面板 `fileChanged` 增长，`broadcasts` 累加
   - 如需兜底“保存立即刷新”，可加：`AILOOM_WS_EAGER_SAVE_ECHO=1`

3) 文件监听
   - 启动：`AILOOM_FSWATCH_ENABLED=1 VITE_WS_DEBUG=1 just dev-all-ws`
   - 本地修改受管文件（排除 `.git/`、`node_modules/` 以及 `.gitignore/.ailoomignore` 命中条目）
   - 预期：WS Frames 出现 `file.changed`/`tree.changed`；面板 `fileChanged`、`tree.batches` 增长

## 整体架构（不拗口版）

- 总体思路：同时拥有“推”和“拉”两套保障。
  - 推（PUSH）：服务端一有事件（保存/监听），就立刻“广播”给所有连接，力求低延迟到达浏览器。
  - 拉（PULL）：即使推送在某些系统/浏览器场景下被节流，服务端也会“按时间间隔从事件环里把你落下的那部分拉出来补发”。
- 写出原则：所有要发给浏览器的帧都走“单写者”，保证“真的写出并 flush 成功才算发出去”。

## 核心模块（后端）

- `Hub`（广播枢纽）
  - 类比“电台发射塔”。负责把来自业务/监听的事件分发给所有连接。
  - 具备轻量去重（如短时间重复的 `file.changed` 不重复入环），并打印“receivers、ring 大小”等观测数据。

- `Ring`（事件环）
  - 类比“最近 N 条新闻的播放单”。按顺序保存最近一段时间的业务事件，每条都有 `eventId`。
  - 用途：断线重连的“增量补发”（`events.resume`），以及服务端“按需拉取补偿”（PULL）。

- `Forwarder`（转发协程，PUSH）
  - 每个连接一个，订阅 Hub 的广播，把“允许的事件”转交给写出通道。
  - 防抖：`tree.changed` 走“只保留最新”（避免刷屏）；`file.changed` 走“队列”（保证不丢）。

- `Writer`（单写者）
  - 整个连接只有一个写出任务，串行写 WebSocket，并在每帧写入后 `flush`。
  - 有软超时：若写/flush 超时，会优先关闭连接，让前端重连 + 增量补偿，保证“卡不死”。

- `Pump`（PULL 补偿）
  - 固定小间隔（默认 ~200ms）检查“我与 Hub 的最新游标差距”，若落后，就从 `Ring` 把缺的事件“拉出来”投递给写出。
  - 作用：就算广播（PUSH）在你的系统里被节流，PULL 也能在 ≤1s 内拉齐（“保存必纠偏”）。

- `Supervisor`（连接监督）
  - 只比较两个数字：`Hub.lastEventId` 与“该连接最后一次实际写出的 `lastSentEventId`”。
  - 若长时间落后（默认 ~1000ms），直接触发自愈：发 `session.resync`（可选）并关闭连接，前端重连 + `events.resume` 补齐。

- `FS Watcher`（文件监听）
  - 把本地编辑器/文件系统变动合批，转换为 `file.changed`/`tree.changed`，交给 Hub。

## 术语与关键词（接地气版）

- `eventId`：每条事件的“编号”。用它来判断你有没有“落下”。
- `events.resume`（增量恢复）：告诉服务端“我上次看到的编号是多少”，让它补发“之后的事件”。
- `tail`：当你编号为 0（刚连上/没有历史）时，直接要最近 N 条（默认 128），避免首屏丢东西。
- `PUSH`：服务端“主动推送”，低延迟；但可能被后台标签页/系统策略节流。
- `PULL`：服务端“主动拉补”，看你落后了就“从环里把缺的补上”，确保不会永远卡住。
- `session.resync`：粗粒度“刷新一下”的指令。当增量补发不划算或你明显落后时，用它告诉前端“先全量读一遍关键视图”。
- `single writer`：单写者。所有帧都从一条写出通道走，写+flush 成功才算“真的发出”。
- `priority/file/tree` 三路通道：
  - `priority`：RPC 响应、`session.resync` 等关键帧（不丢、优先写）。
  - `file`：`file.changed`、`annotations.*`（按序、不可丢）。
  - `tree`：`tree.changed`（只取最新，避免刷屏）。

## 关键时序（保存一次会发生什么）

1) 你点击保存 → 后端写入文件成功 → Hub 立刻广播 `file.changed`；若开启监听，稍后也会有 `tree.changed`。
2) 转发（PUSH）尝试把这两条事件送到浏览器；写出任务对每帧 `send+flush`，失败就关闭连接。
3) 如果 PUSH 在你的系统里被节流：`Pump` 会在 ~200ms 内发现“你落后了”，从 `Ring` 把刚才那两条补发过来。
4) 若还是没追上（例如浏览器长时间挂起）：`Supervisor` 在 ~1000ms 触发自愈，发 `session.resync`（可选）并关闭连接 → 重连后用 `events.resume(tail=128)` 补齐。

## 为什么要 Hub + Ring（浅白版）

- Hub 让“广播”又快又省事（像电台）。Ring 让“补课”有据可依（有播放单就能从断点继续）。
- 只要两者同时存在：
  - 正常时你享受低延迟推送（PUSH）。
  - 异常时你靠 ring 的编号做增量恢复（PULL/resume），不会永远卡住。


## 排障清单（FAQ）

- 只有 `WS: online`，其它数字不动？
  - 检查是否真的有事件产生（空闲时 `events/s=0` 正常）
  - 确认服务端是否在推送 `session.stats`（后端日志或 WS Frames 中可见 `session.stats`）
  - 若使用代理/网关，请确认 WS 升级与帧未被拦截

- 首屏看到很多 `session.info` 响应？
  - 这是面板的 RTT 采样请求；如需静音，直接取消 `VITE_WS_DEBUG=1`

- `ring` 接近或达到上限（红色告警）怎么办？
  - 说明广播速率高于消费速率；观察 `droppedLowPri` 是否增长（树摘要在压力下会优先丢弃）
  - 建议暂时减小事件源密度（例如调低监听风暴），或增加消费侧处理能力；必要时再评估提升 ring 容量

- `broadcastErrors` > 0 是严重错误吗？
  - 通常为连接关闭瞬间的写失败；少量增长可忽略，持续增长需排查异常断开

- 开启监听但没有 `file.changed/tree.changed`？
  - 确认已设置 `AILOOM_FSWATCH_ENABLED=1` 且后端日志打印了 watcher 启动
  - 确认改动路径未被忽略：`.gitignore/.ailoomignore`、`.git/`、`node_modules/`

## 术语与关键词解释（类比友好版）

- WS 优先（WS-first）：能走 WebSocket 就走 WS；不行再走 REST。类比“走高速，堵车了再走省道”。
- 回退（fallback）：WS 出错/不可用/超时后，自动改走 REST 的同功能接口。
- 短窗熔断（fuse）：某方法在很短时间窗口（默认 1500ms，可配）刚出现“传输/能力类错误”（如 WS_DOWN/TIMEOUT/MESSAGE_TOO_LARGE）时，窗口期内直接用 REST，避免 WS/REST 之间来回抖动。类比“前方湿滑，先绕行一小段时间”。
- 纯 WS（no-fallback）：禁止回退与熔断，必要时等待 WS 就绪后再发首批请求，用于强制验证 WS 路径的稳定性与等价性。
- RTT（Round Trip Time）：一次请求从前端出发到服务端再返回的往返时间，面板每 5 秒用 `session.info` 轻量采样一次。类比“打个招呼来回要多少毫秒”。
- 事件环（ring / ring buffer）：固定容量的服务端事件队列（统计 `ringSize/ringCap`）；满了会按策略丢弃低优先级事件（见 droppedLowPri）。类比“一圈座位坐满了，就请低优先级乘客先等下一班”。
- 低优先级丢弃（droppedLowPri）：树摘要（`tree.changed`）为低优先；环容量紧张时优先丢弃，以保障 `file.changed/annotations.*` 这类更关键的事件。
- 订阅（subscribe topic+filter）：前端声明感兴趣的主题与过滤条件（如 `tree:{dir}`、`file:{path/prefix}`、`annotations:{}`），服务端只推送匹配的事件。
- 广播（broadcast）：服务端向订阅者推送事件；统计里有 `broadcastTotal/Errors/noReceiver`（无接收者次数）。
- 监听（fswatch）：服务端本地文件系统变更监听（可选，`AILOOM_FSWATCH_ENABLED=1`），会推送 `file.changed` 与 `tree.changed` 摘要（合批/节流/忽略 .gitignore/.ailoomignore）。
- impactedPaths / truncated：`tree.changed` 摘要里包含受影响路径集合；超出上限则截断（`truncated: true`），前端退化为粗粒度刷新当前视图根。
- events.resume：断线重连后带上 `after=lastEventId` 请求补发断线期间的增量事件；若环已清（缺口太大），则转而触发 `session.resync`。
- session.resync：指示前端做一次粗粒度刷新来弥补增量缺口。
- digest：文件内容指纹（散列）；用于 `file.save` 冲突检测与前端事件去重（优先以带 digest 的变更为准）。
- 合批 & 去重：前端用 `requestAnimationFrame` 合批失效、用一个短窗（默认 800ms）按 `digest/path` 去重，避免 UI 频繁抖动。
- 路由决策日志（`VITE_WS_DEBUG_ROUTE=1`）：打印 `[wsPrefer] WS ... / REST(fuse) ... / REST(error) ... / WS(error, no-fallback) ...` 帮助理解每次调用为何走 WS 或 REST。
- 常见错误码：
  - `MESSAGE_TOO_LARGE`（WS）/`HTTP_413`（REST）：载荷过大（例如全文预览超限）
  - `TIMEOUT`：请求超时（默认 15s，可配 `VITE_WS_TIMEOUT_MS`）
  - `WS_DOWN`：WS 未连接成功或连接中
  - `WS_DISABLED`：前端禁用了 WS（如 `VITE_USE_WS=0`）
  - `NOT_SUPPORTED`：服务端未提供相关能力（如缺少 hub）
  - `CONFLICT:...`：保存时的内容冲突（基于 digest 比对）
- 读取 vs 写入：读取是读数据（`tree.get/file.get* / annotations.list`），写入是改数据（保存文件、注解 CRUD/导入/校验）。当前默认“读取走 WS，写入多数走 REST”，开启 `VITE_WS_WRITE=1` 可让保存走 WS。

- Hub（事件枢纽）
  - 定义：服务端的事件中枢（内含 ring-buffer、事件 id、自身统计），对所有连接扮演“发布源”的角色。
  - 作用：接收来自业务/监听的事件，入 ring 后通过 `broadcast` 将事件分发到所有订阅者（每个连接各自有一条转发协程监听）。
  - 类比：广播电台（Hub）+ 电台节目单（ring 中的事件序列 id）。

- 转发协程（per-connection forward task）
  - 定义：每个 WS 连接在服务端上的一个独立异步任务，订阅 Hub 的事件并把事件写到对应的 WebSocket 连接中。
  - 作用：把 Hub 中的事件“真正送”到浏览器；如果它挂起/阻塞，页面就收不到 file.changed/tree.changed，即使 Hub 已广播成功。
  - 自愈策略：写出软超时（避免半挂）、遇错自动重订阅、强自愈（FORCE_RECOVER：N 秒无写出则对该连接下发 `session.resync` 并强制断开 → 重连 + resume）。

- 事件流（端到端）
  - 源：业务写入（保存）/监听（fswatch） → Hub（入 ring、分发） → 转发协程（每连接）→ 浏览器 WS → 前端订阅/缓存失效。
  - 增量恢复：连接断开或 lag 时，前端以 `lastEventId` 调 `events.resume`（after/tail）补齐；必要时服务端会下发 `session.resync` 提示前端粗粒度刷新。

- 无条件直通（直发不过滤）
  - 为避免订阅时序抖动导致漏发，服务端对以下事件“无条件转发”：`session.stats`、`file.changed`、`tree.changed`、`session.resync`。
  - 开发期可开启 `AILOOM_WS_UNFILTERED=1`，把所有事件都直通（便于定位“写出层”问题）。

## “短窗熔断”详细说明（What/Why/How）

一句话：某方法一旦刚发生“传输/能力类错误”，在一个很短的时间窗口内（默认 1500ms）直接走 REST，暂不再尝试 WS，避免抖动和卡顿；窗口结束后自动恢复 WS 尝试。

- 为什么需要
  - 首屏或弱网下，WS 可能还在握手（connecting），立即发 WS 常得到 `WS_DOWN/TIMEOUT`，体验抖动；先短暂走 REST 能更稳。
  - 瞬时异常（风暴/网络抖动）导致连续失败时，继续尝试 WS 大概率还是错；短时间直接回退 REST 能尽快给结果，保证“功能不退化”。

- 怎么做（本项目轻量版 Circuit Breaker）
  - 作用域：按方法名（如 `'tree.get'/'file.getChunk'`）单独计时。
  - 错误类型：把 `MESSAGE_TOO_LARGE/WS_DOWN/TIMEOUT/WS_DISABLED/NOT_SUPPORTED` 视为“传输/能力类错误”。
  - 熔断窗口：`fuseMs`，默认 1500ms（可通过 `VITE_WS_FUSE_MS` 配置）。
  - 行为：
    1) 发起调用前，若当前方法仍在熔断窗口内 → 直接 REST，日志打印 `[wsPrefer] REST(fuse)`。
    2) 若 WS 调用抛出“传输/能力类错误” → 记录熔断窗口（方法级）、并回退 REST（除非纯 WS 模式）。
  - 纯 WS 验证（no‑fallback）：`VITE_WS_NO_FALLBACK=1` 时不设置/不遵从熔断，并在首批调用前“等待 WS 上线（最多约 1s）”再发请求，避免一上来就撞在 connecting。
  - 实现位置：`packages/web/src/lib/ws/query-helpers.ts`（`wsPrefer`）。

- 时序例子
  - 常规（允许回退）
    - T0：首屏 `tree.get` → WS 还在 connecting → 抛 `WS_DOWN` → 设置 1500ms 熔断，回退 REST → `[wsPrefer] REST(error)`
    - T0+200ms：`file.getChunk` → 命中熔断窗口 → 直接 REST → `[wsPrefer] REST(fuse)`
    - T0+1600ms：熔断窗口结束，WS 已 up → 新请求继续走 WS → `[wsPrefer] WS ...`
- 纯 WS 验证（`just dev-all-ws`）
    - 首批调用先等待 WS up（最多 ~1s），然后用 WS 调用；整个流程不回退、不熔断。

- 调参与开关
  - `VITE_WS_FUSE_MS`：熔断窗口毫秒数；0 表示关闭熔断（不建议用于日常，但可用于实验）。
  - `VITE_WS_NO_FALLBACK=1`：禁用回退与熔断；用于强制验证 WS 路径，已内置在 `just dev-all-ws`。
  - `VITE_WS_DEBUG_ROUTE=1`：打印路由决策，便于看到 `[wsPrefer] WS` / `REST(fuse)` / `REST(error)` / `WS(error, no-fallback)`。

- 与“标准熔断器”的区别
  - 标准 Circuit Breaker 有 Closed/Open/Half‑Open 状态与错误阈值统计；
  - 我们采用“轻量短窗”策略：无需状态机、易读易调，足以抑制短时抖动。

- 可观测信号（如何确认生效）
  - 控制台（开 `VITE_WS_DEBUG_ROUTE=1`）：出现 `REST(fuse)` 表示命中短窗；大量 `REST(error)` 表示 WS 出错已触发回退。
  - 面板：RTT 抖动/事件速率波动可辅助判断网络/服务抖动；配合 `events/s` 与服务端日志一起分析。

## 前端集成要点（Explorer）

- 开发策略：默认读取优先 WS（`wsPrefer`），短窗熔断回退 REST；写入默认 REST，写后由 WS 广播驱动缓存失效/直改。
- 订阅桥：`packages/web/src/features/explorer/subscriptions.ts`（随页面装载/卸载，自动重订阅）。
- 领域化失效器：
  - 文件：`packages/web/src/features/explorer/ws-invalidators/file-invalidator.ts`
  - 目录树：`packages/web/src/features/explorer/ws-invalidators/tree-invalidator.ts`
  - 批注：`packages/web/src/features/explorer/ws-invalidators/annotations-invalidator.ts`
  - 聚合安装：`packages/web/src/features/explorer/invalidations.ts`（在 `explorer-page.tsx` 中调用 `useExplorerInvalidations()`）。
- 查询辅助：`packages/web/src/lib/ws/query-helpers.ts`（WS 优先 + 回退 + 取消）。

## 相关代码位置（便于深入调试）

- 面板实现：`packages/web/src/lib/ws/ws-debug-panel.tsx`
- WS 客户端：`packages/web/src/lib/ws/rx-client.ts`
- 订阅挂载：`packages/web/src/features/explorer/subscriptions.ts`
- 缓存失效：`packages/web/src/features/explorer/ws-invalidators/*`、`packages/web/src/features/explorer/invalidations.ts`
- WS 请求优先与回退策略：`packages/web/src/lib/ws/query-helpers.ts`
- 服务端方法：`packages/rust/ailoom-server/src/ws/methods.rs`（`session.info`、`events.resume` 等）
- 服务端转发与订阅过滤：`packages/rust/ailoom-server/src/ws/conn.rs`（`session.stats` 无条件转发）
- 周期性统计广播：`packages/rust/ailoom-server/src/main.rs`（每 2s 推送 `session.stats`）
- 文件监听与摘要：`packages/rust/ailoom-server/src/ws/watch.rs`

## 建议使用习惯

- 验证 WS 路由选择时，配合 `VITE_WS_DEBUG_ROUTE=1` 观察控制台 `[wsPrefer] WS/REST(...)` 决策
- 执行回归/压测前打开面板，可一眼发现 ring 压力、丢弃、无订阅等异常
- 问题复现时点击“复制快照”，把快照与后端日志片段一并附到工单，便于定位

## 命令与默认开关速查

- `just dev-all`（生产一致一键联动）
  - 前端：`VITE_USE_WS=1`（默认开启 WS）
  - 后端：无需额外 env；服务端默认生效的关键参数：
    - 写出软超时：`AILOOM_BROADCAST_SEND_TIMEOUT_MS=1000`（可覆盖为 1500 等）
    - 监督器：`AILOOM_WS_SUPERVISOR=1`（默认开启）
    - 自愈关闭优先：`AILOOM_WS_RECOVER_CLOSE_FIRST=1`（默认开启）
    - 去重窗口：`AILOOM_WS_DEDUP_MS=200`
    - Pump 周期：约 200ms（内置常量）
    - file/tree 分流：file 队列（cap≈256）、tree 保留最新

- `just dev-all-debug`（与生产一致，仅打开日志/面板/监听）
  - 前端：`VITE_WS_DEBUG=1`
  - 后端：`RUST_LOG=ws=info,fswatch=info`、`AILOOM_FSWATCH_ENABLED=1`
  - 其余与 `dev-all` 一致（行为不变，仅可观测增强）

- `just dev-all-ws`（纯 WS 验证：禁用回退与熔断）
  - 前端：`VITE_USE_WS=1 VITE_WS_NO_FALLBACK=1 VITE_WS_FUSE_MS=0 VITE_WS_WRITE=1 VITE_WS_DEBUG=1`
  - 后端：`AILOOM_FSWATCH_ENABLED=1`、`AILOOM_BROADCAST_SEND_TIMEOUT_MS=800`、`RUST_LOG=ws=info,fswatch=info`
  - 说明：更激进的 800ms 软超时便于尽快触发 `close-first + resume`，用于验证纯 WS 链路。
