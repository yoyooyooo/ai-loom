# Chat 会话长时间挂起/卡顿或崩溃（单会话与多会话并行）— 性能问题分析与预案（2025-10-31）

- 影响范围：前端聊天页面（单/多会话并行）、WS 事件链路、渲染与滚动
- 结论概要：主要由“高频流式增量 + 大文本/大 diff + Markdown/代码高亮 + 自动滚动与回流”叠加导致的 CPU/内存压力；在大输出或网络波动时，后端 Writer 自愈 + resume 可能放大前端事件处理峰值。
- 状态：已完成端到端排查与可行缓解方案；建议先行通过环境变量降压与观测验证，再推进中期代码层改进。

## 背景

在以下场景中页面出现长时间挂起、明显卡顿甚至崩溃：

- 单个会话长时间流式输出（assistant 正文/推理、工具输出），尤其包含多段代码块、长日志或大 diff；
- 多个会话并行生成，非当前会话的事件同样进入前端处理链路；
- 偶发网络/浏览器状态导致 WS 自愈重连 + resume，短时间回放大量事件。

未确定的可疑点包括：

- 增量过多导致密集计算（解析 Markdown、语法高亮、字符串拼接与截断）；
- 自动滚动到底的逻辑触发频繁回流/重排；
- 长时间运行导致内存占用上升（工具输出较大、影子缓存聚合）。

## 症状与触发条件

- 浏览器 CPU 占用飙升、FPS 下降，页面响应迟缓，极端时标签页崩溃；
- 内存随时间增长（长会话/并行会话更明显）；
- WS Debug 面板可见 resync 次数上升，短时事件速率提升；
- 常见诱因：
  - 连续的 `chat.message.delta`/`chat.reasoning.delta`（流式文本，含多代码块）；
  - 大体量 `chat.tool.exec.output`（stdout/stderr 日志）或 `chat.tool.patch.*`（大 diff 渲染）；
  - 多会话同时活跃；
  - 刻意或偶发网络抖动引发 Writer 超时→自愈→resume 的事件“风暴”。

## 相关链路概览（端到端）

- 服务端（Rust）
  - Hub ring + resume：`packages/rust/ailoom-server/src/ws/hub.rs`
  - Writer 写出与自愈：`packages/rust/ailoom-server/src/ws/conn.rs`（`AILOOM_BROADCAST_SEND_TIMEOUT_MS` 超时触发 close-first），`ws/config.rs`、`main.rs`（`AILOOM_WS_RING_CAP`）。
  - 观测：`session.stats` 为瞬时事件（不入 ring）；`session.resync` 用于促使前端重连 + resume。
- 前端 WS 客户端
  - 连接/去重/按会话 resume：`packages/web/src/lib/ws/rx-client.ts`
  - 增量微批（默认 16ms）：`packages/web/src/features/codex-chat/services/delta-streams.ts`
- 事件处理与分片存储：`packages/web/src/features/codex-chat/services/ws.ts` → `processors/*` → `chat-turns-*`
- 前端渲染与滚动
  - 助手正文 Markdown + Shiki 代码高亮：`packages/web/src/components/ui/markdown-renderer.tsx`
  - 工具输出/补丁卡片：`features/codex-chat/components/cards/*`
  - 自动滚动与粘底：`features/codex-chat/components/turns-panel.tsx`、`stores/chat-scroll-utils.ts`
  - 大输出影子缓存（避免频繁重渲染）：`features/codex-chat/stores/exec-output-vault.ts`

## 可能原因（热点）

1) 流式 Markdown 渲染 + Shiki 高亮的 CPU 热点
- 每个增量触发 `react-markdown` 解析与 `shiki` token 化，尤其含多代码块时开销大。

2) 大体量工具输出的高频拼接与截断
- `appendStep` 在超过 `VITE_CHAT_TOOL_MAX_OUTPUT_CHARS`（默认 100k）时每次增量都会做头尾截断与字符串重拷贝，CPU/内存开销高。
- 影子缓存 Map 每步默认最多 5MB（`VITE_CHAT_EXEC_VAULT_MAX_BYTES_PER_STEP`），并行多步/长会话可能持有较多内存，尽管在 turn 完成时会清理。

3) 自动滚动导致的布局抖动
- 多处在内容/尺寸变化时“强制到底”，即使变动很小也会频繁读写 `scrollTop/scrollHeight`，造成回流。

4) 多会话并行处理成本
- 订阅为 `chat` 主题全量；非当前会话事件同样进入处理链路（构造步骤、索引更新），虽不渲染但仍消耗 CPU。

5) Writer 自愈与 resume 放大峰值
- 大帧/慢端下 Writer 发送或 flush 超时触发自愈关闭，重连后 resume 回放，短时事件密度上升，前端处理负载加剧。

## 复现与观测

- 前端环境变量（建议本地 .env.dev）：
  - `VITE_WS_DEBUG=1` 打开 WS 面板，观察 `events/s`、`resync count`、ring 占用；
  - `VITE_CHAT_TRACE=1` 打印事件处理路径日志；
- DevTools：
  - Performance 录制：关注 `react-markdown`/`shiki`/布局（Layout/Style）热点；
  - Memory Timeline：观察堆增长与快照对比（搜索 `exec-output-vault` 持有的字符串）。
- 触发脚本/场景：
  - 发送含多代码块的长回复；
  - 执行产生日志洪峰的命令（多段 `chat.tool.exec.output`）；
  - 并行开启 2–3 个会话同时生成；
  - 刻意模拟网络抖动（断网 2–3s 再恢复），观察 resume 行为与峰值。

## 暂行缓解（无代码）

优先通过参数调优降低峰值，验证有效性后再决定代码级改造：

- 流式频率 → 降低微批频率
  - `VITE_CHAT_BATCH_MS=33` 或 `50`（默认 16）。
- 临时关闭 Markdown 渲染（禁用解析与高亮）
  - `VITE_CHAT_MARKDOWN_DISABLE=1` 或 `true`（重载页面生效）。
- 临时隐藏非 patch/thinking 正文（store 预处理，不入内存）
  - `VITE_CHAT_HIDE_NONPATCH_OUTPUTS=1`（默认即开启）；仅保留 patch diff 与 thinking 正文，其它正文（包括助手最终文本/exec 输出/plan/info 正文等）不入 store、不展示。
- 自动滚动调优（减少回流/重排）
  - `VITE_CHAT_AUTOSCROLL_DISABLE=1` 禁用自动粘底，仅保留“回到当前”按钮
  - `VITE_CHAT_AUTOSCROLL_MIN_MS=120` 自动滚动的最小间隔（ms）
  - `VITE_CHAT_AUTOSCROLL_MIN_DELTA=40` 触发自动滚动所需的最小高度增长（px）
- 工具输出体量 → 更快进入截断
  - `VITE_CHAT_TOOL_MAX_OUTPUT_CHARS=40000`（默认 100000）。
  - `VITE_CHAT_EXEC_VAULT_MAX_BYTES_PER_STEP=1048576`（默认 5MB/步）。
- 补丁 diff 展示体量 → 缩小渲染开销
  - `VITE_CHAT_PATCH_MAX_FILES=8`
  - `VITE_CHAT_PATCH_MAX_CHARS=15000`（默认无限）。
- 后端写出容忍度与自愈
  - `AILOOM_BROADCAST_SEND_TIMEOUT_MS=1500~2500`（默认 1000），降低 flush 超时关闭概率；
  - 观察 `AILOOM_WS_SUPERVISOR` 开/关对 resync 频率的影响（默认 1）。

验证标准：WS 面板 `events/s` 降低、resync 次数减少；DevTools 性能录制中渲染/布局耗时下降；长压 10–15 分钟堆内存趋于平稳。

## 中长期改进（需要改代码）

1) 流式正文“降级高亮”
- streaming 阶段禁用 Shiki，仅用轻量 Markdown/纯文本；在 `chat.message.completed` 后一次性高亮。
- 位置：`components/ui/chat-message.tsx` 与 `features/codex-chat/components/turn-item.tsx`（根据 turn.status 切换组件）。

2) 截断节流
- 达阈值后按“时间或增量次数”节流 `truncateIfNeeded`，避免每个 chunk 都重切片 10 万级字符串。
- 位置：`features/codex-chat/stores/chat-turns-core.ts`（`appendStep` → `truncateIfNeeded`）。

3) 自动滚动去抖/阈值
- 对 `contentKey` 触发的粘底增加 100–150ms 去抖；`ResizeObserver` 仅在高度变更超过阈值时粘底；
- 优先在“步骤完成/turn 边界”触发强制到底，流式期间减少强制滚动。
- 位置：`features/codex-chat/components/turns-panel.tsx`。

4) 列表虚拟化
- 对 Turns/Steps 使用 `react-window`/`react-virtuoso`，显著降低 DOM 与布局成本。

5) 非当前会话的轻量处理
- 在 `processors/*` 对非当前会话降级：跳过重型正文（如大 diff body），仅保留元信息或在 completed 时补齐。
- 保持 SSoT 语义不变（不影响入环事件，前端仅作 UI/内存优化）。

以上改动若触及“事件入环/边界/Resume 语义”，必须先更新 `docs/guide/*` 的对应章节再落地代码（遵守 SSoT）。

## 验证计划

- 基线采样：记录现状 CPU/内存/`events/s`/resync 次数；
- 逐项施策 → 复测对比（同一数据集/同一操作序列）；
- 压测用例：
  - 长流式正文（含 5+ 代码块），持续 10 分钟；
  - 每秒 10–20 行 `exec.output`，持续 5 分钟；
  - 3 个会话并行，每个包含上述两类流；
  - 插入 2–3 次网络抖动；
- 通过标准：页面可交互性维持，FPS 明显提升，堆稳定，Tab 不崩溃。

## 关键代码与文档索引（便于定位）

- 前端 WS 客户端与微批：
  - `packages/web/src/lib/ws/rx-client.ts`
  - `packages/web/src/features/codex-chat/services/delta-streams.ts`
  - `packages/web/src/features/codex-chat/services/ws.ts`
- 前端存储与输出截断/影子缓存：
  - `packages/web/src/features/codex-chat/stores/chat-turns-core.ts`
  - `packages/web/src/features/codex-chat/stores/exec-output-vault.ts`
- 渲染与滚动：
  - `packages/web/src/components/ui/markdown-renderer.tsx`
  - `packages/web/src/features/codex-chat/components/turns-panel.tsx`
  - `packages/web/src/features/codex-chat/stores/chat-scroll-utils.ts`
- 后端：
  - `packages/rust/ailoom-server/src/ws/hub.rs`
  - `packages/rust/ailoom-server/src/ws/conn.rs`
  - `packages/rust/ailoom-server/src/ws/config.rs`
- 规范与参考：
  - `docs/guide/codex-chat-turn-ssot.md`
  - `docs/guide/codex-chat-ws-ssot.md`
  - `docs/guide/ws-overview.md`

## 行动项（建议顺序）

1) 先行调参降压并采样对比（前端/后端 env）。
2) 落地“流式降级高亮”与“滚动去抖/阈值”。
3) 为截断加入节流策略；降低默认输出/diff 上限值。
4) 引入列表虚拟化（Turns/Steps）。
5) 对非当前会话启用轻量处理策略。
6) 若涉及 SSoT 变更（事件边界/入环/Resume），先更新 `docs/guide/*` 并附验证步骤。

---

如需将本议题纳入里程碑，请在 PR 内链接本文件并附上对比数据（CPU/内存/`events/s`/resync 次数、重放视频或截图）。
