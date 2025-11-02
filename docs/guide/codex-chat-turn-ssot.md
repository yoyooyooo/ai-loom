# Codex Chat Turn SSOT（单一事实源）

> 说明：事件命名、入环/不入环与字段规范请以《Codex Chat WS 事件（SSoT）》为准（含“事件分类索引”与完整 `chat.info.*` 清单）。本文聚焦 turn 边界、turnSeq 计算与 resume 回放规则，并在必要处提供“映射对照”的导航链接，以避免双处维护产生漂移。

本文描述 Codex Chat 在“以 Turn 为一等公民”的单一事实源（SSOT）模型：实时（WS）与恢复（resume rollout）两路如何统一为同一套数据结构与渲染逻辑，以及若干特殊事件的处理约定。

## 目标

- 单个 Turn = 1 条用户气泡 + 1 条 AI 气泡，工具明细聚合在 `turn.steps`。
- 实时与恢复共用同一套事件归一化和 Store reducer，UI/状态收敛。
- 推理（reasoning）作为折叠块附着到 AI 气泡；正文常显，Working/Finished 聚合步骤在同一气泡内。

## 实时（WS）路径

1) 事件归一化（服务端）
- 文件：`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs:62`
- 将 `codex/event/*` 归一化为平台层 `chat.*` 并附带 `conversationId` 后入环，例如：
  - `codex/event/agent_message` → `chat.message.completed`（当文本为 `Compact task completed` 时标记特殊态用于后续高亮）。

2) 事件处理（前端）
- 文件：`packages/web/src/features/codex-chat/services/processors/index.ts`
- 核心映射：
  - `chat.turn.started` → `markTurnStarted`（不入环，仅提示；避免乱序误开新轮）
  - `chat.message.delta` → `appendAssistantDelta`（Rx 微批在 `delta-streams.ts` 中完成）
  - `chat.message.completed` → `completeAssistant`
  - `chat.reasoning.end` → `endReasoning`（并生成 thinking 步骤，去冗余）
  - `chat.tool.*`（exec/patch/mcp）→ `addStep/appendStep/endStep`
  - `chat.turn.complete` → `completeTurn`

3) “Compact task completed”的实时处理
- 依然在当前活跃 Turn 内，`completeAssistant(text)` 后追加一条 info 步骤 `[Compact] 任务完成`，不会新建 Turn。

## 恢复（Resume rollout）路径

1) 后端回放（rollout → ChatEvent）
- 文件：`packages/rust/ailoom-server/src/routes/chat/resume/event_accumulator.rs:168`
- 对 `event_msg.agent_message`：若当前未显式打开 turn，会插入 `chat.turn.started`，并在同一轮推入 `chat.message.completed`。

2) 前端应用（history + events → turns）
- 文件：`packages/web/src/features/codex-chat/stores/chat-turns.ts:236`
- `loadSnapshot(history, events)`：
  - 先将 `history` 组装成基础的若干 Turn；
  - 再调用 `applyEventsToTurns` 将工具步骤与边界补齐（events-only 场景也支持）。

3) “Compact task completed”的恢复特殊处理
- 文件：`packages/web/src/features/codex-chat/stores/chat-turns.ts:288`
- 如果事件是 `chat.message.completed` 且文本为 `Compact task completed`：
  - 不按普通 completed 收尾；
  - 作为一条 info 步骤追加到“当前/上一轮” Turn：
    - 若该事件前刚被 `chat.turn.started` 触发创建了一个空转（id 以 `turn-events_` 开头、无正文/步骤），则删除这个空转并将 info 合并到上一轮；
    - 若没有活动 Turn 但存在历史 Turn，则追加到最后一轮；
    - 完全没有 Turn 则跳过。
  - 这样恢复路径与实时路径一致，不会产生“独立的 Compact turn”。

## 工具名称与面板折叠

1) MCP 名称约定
- 优先采用 `<server>__<tool>`；兼容历史格式 `mcp__<server>__<tool>`、`mcp:<server>/<tool>`。
- 解析位置：`packages/rust/ailoom-server/src/routes/chat/resume/event_accumulator.rs`（`response_item.function_call` 分支）。
- 覆盖用例：`packages/rust/ailoom-server/src/routes/chat/resume/tests.rs:207`。

2) 工具面板最大高度
- 为 `exec`/`mcp`/`patch` 的展开内容设定最大高度 200px，溢出滚动，避免超高撑屏。
- 文件：
  - `packages/web/src/features/codex-chat/components/turn-item.tsx:175`
  - `packages/web/src/features/codex-chat/components/turn-item.tsx:203`
  - `packages/web/src/features/codex-chat/components/turn-item.tsx:244`

## 统一渲染（Turn → Timeline）

- Turn 数据结构：后端 SSoT（`packages/rust/ailoom-server/src/routes/chat/resume/turn_types.rs`）通过 `ts-rs` 导出到 `packages/web/src/features/codex-chat/types/generated/turns.ts`，前端 store 仅引用生成类型（`chat-turns.types.ts` 做别名）。
- 渲染组件：`packages/web/src/features/codex-chat/components/turn-item.tsx`
  - 顶部折叠：Working/Finished working（渲染 `turn.steps`）
  - 推理折叠：`turn.reasoning`（标题取首行摘要）
  - 正文：`turn.assistant.text`（常显）

Hydration 提示：
- “正在加载会话…” 状态严格等价于握手窗口（`chat.session.sync_begin → chat.session.sync_end`），不参与 Store 落库，仅驱动 UI。

#### 实时 vs 恢复的“仅推理”展示差异（避免错觉）

- 实时（WS）：当本轮仅有推理（`reasoning.delta` 尚未形成任何 `steps`）时，依然显示“Working”折叠区，并把当前推理作为临时项置于该折叠区中；一旦收到 `chat.reasoning.end` 或其它工具步骤开始，按正常步骤列表渲染。
- 恢复（resume）：turn-first 投影会把 reasoning 汇总为 `thinking` 步骤，落入 Working 折叠（默认收起）；若快照中确实不存在步骤（极端兼容案例），仍旧回退到独立的“thinking”折叠块。
- 目的：解决“实时初始阶段只见 thinking --- 而非 Working”的体验断层，同时保持历史快照的可读性。

### 前端 Working 推导规则（无冗余字段）

- 移除每个 Turn 内的 `meta.working`、`meta.workingTitle` 等冗余字段，遵循 SSoT 原则，仅由现有状态推导：
  - `working = (turn.status === 'streaming') || turn.steps.some(s => s.status === 'streaming')`
  - `workingTitle = turn.status==='failed' ? 'Failed' : turn.status==='aborted' ? 'Aborted' : working ? 'Working' : 'Finished working'`
- Store 提供 `deriveWorkingState(turnId)` 便捷方法，UI 读取并渲染；不在 Store 中落盘冗余工作态。
- 唯一活跃 Turn 由 `activeTurnId` 表示；完成（`chat.turn.complete`）后清理该索引并清空工具步骤索引（避免跨轮污染）。
- 交互约定：Working 折叠区默认收起（`defaultOpen=false`）；生成中不强制展开，结束后标题自动从 `Working` 变为 `Finished working`。

### Rx 批处理与缺失 started 的隐式开启

- 在启用 Rx 微批（`chat.message.delta`/`chat.reasoning.delta`）时，若未收到 `chat.turn.started`，首条“内容事件”（delta）到达即隐式触发 `beginTurn()`，确保与“开始优先级”一致。
- `agent_message.completed`（非 Compact）到达时，立即完成助手文本并结束本轮（`completeAssistant` + `completeTurn`）；`chat.turn.complete` 作为确认型收尾（幂等）。

实现差异说明（与历史描述的偏差）
- 结束边界：当前前端在 WS 路径以 `chat.turn.complete` 作为“确认型收尾”，`chat.message.completed` 仅完成本轮助手正文，不强制结束 turn（若仍有工具步骤 streaming，会保持 Working）。Resume 路径按本文档“结束优先级”同样产出 `chat.turn.complete`；如缺失，则以 `chat.message.completed` 收尾由 reducer 兜底。
- Compact 特例：文本为 `Compact task completed` 的 `chat.message.completed` 不结束 turn，并转为 info 步骤插入当前活跃 turn；若刚刚创建了空转（仅由 started 打开），会合并回上一轮。

## 完整事件映射与兜底顺序（索引）

以下为“事件→Store”在实时与恢复两路的统一约定；详细实现请参考对应文件：

- Turn 边界与收尾
  - `chat.turn.started` → 开启/标记当前 Turn（若缺失，首次 `chat.message.delta` 也会触发开启）
    - 代码：packages/web/src/features/codex-chat/services/processors/index.ts，packages/web/src/features/codex-chat/stores/chat-turns.ts:595
  - `chat.message.completed` → `completeAssistant(text)`；若仍有 streaming 步骤，保持 Working 状态；否则 Finished
    - 代码：packages/web/src/features/codex-chat/services/processors/message.ts，packages/web/src/features/codex-chat/stores/chat-turns.ts:659
  - `chat.message.failed|aborted` → `fail|abortAssistant()` 并 `completeTurn()` 兜底
    - 代码：packages/web/src/features/codex-chat/services/processors/reasoning.ts
  - `chat.turn.complete` → `completeTurn()`（明确收尾的屏障）
    - 代码：packages/web/src/features/codex-chat/services/processors/tools.ts

- 推理（Reasoning）
  - `chat.reasoning.delta` → `appendReasoning(delta)`
  - `chat.reasoning.end` → 生成/更新 thinking 步骤（避免重复）
    - 代码：packages/web/src/features/codex-chat/services/processors/turn.ts，packages/web/src/features/codex-chat/stores/chat-turns.ts:372, 404

- 工具步骤（Steps）
  - Exec：`chat.tool.exec.begin|output|end` → `addStep('exec')` / `appendStep()` / `endStep()`
  - Patch：`chat.tool.patch.begin|end` → `addStep('patch')` / `endStep()`
  - MCP：`chat.tool.mcp.begin|end` → `addStep('mcp')` / `endStep()`
    - 代码：packages/web/src/features/codex-chat/services/processors/info.ts，packages/web/src/features/codex-chat/stores/chat-turns.ts:398-518

- 恢复定位规则（events-only 也适用）
  - 若事件携带 `turnSeq` → 按 `seq` 精确落位。
  - 若缺失 `turnSeq` → 附加到“当前/最后一轮”；如遇 `chat.turn.started` 会创建骨架。
    - 代码：packages/web/src/features/codex-chat/stores/chat-turns.ts:236-338, 340-418

- Compact 特例（恢复）
  - `chat.message.completed(text === 'Compact task completed')` 不作为普通收尾：合并为 info 步骤到当前/上一轮；若刚由 started 建了“空转”，删除该空转再合并。
    - 代码：packages/web/src/features/codex-chat/stores/chat-turns.ts:288

补充参考：
- WS SSOT：docs/guide/codex-chat-ws-ssot.md
- Turn/Step 模型与 reducer：本文“前端数据模型与 Store API”小节
- 渲染与性能：本文“性能与渲染建议（流式优化）”小节

## 说明与建议

- 若未来希望在后端避免“event_msg.agent_message → started + completed”的回放策略，也可在后端直接把特定模板消息映射为 info 事件；当前前端已做兼容并保证行为一致。
- 若有更多模板化系统消息（如 Background/Review 状态）也希望合并到当前 turn，可按同样模式加入白名单。

---

# Codex Turn-first SSoT（WS 与 Resume 一体化）

本文档定义 Codex 聊天时间线在“以 turn 为一等公民（turn-first）”架构下的单一事实源（Single Source of Truth，SSoT）。目标是让 App Server 的实时通知（WS）与 resume 的 JSONL 日志在后端统一归一化为平台层 `chat.*` 事件，前端仅消费 `chat.*` 事件，通过同一套 reducer 合并为 Turn 序列。

- 范围：后端事件归一化与 resume 解析（Rust，`ailoom-server`），前端消费（TS/React）。
- 依赖：本文“前端数据模型与 Store API”。
- 关联：`docs/guide/codex-chat-ws-ssot.md`（WS 事件与通道说明）。

## 设计目标

- 单事实源：统一以“平台层 `chat.*` 事件序列”为唯一事实源（SSoT）。
- 单一管线：WS 与 resume 都产出同构的 `chat.*` 事件，前端只实现一条“事件 → turn 合并”的逻辑。
- Turn 边界清晰：明确开始/结束事件集合；缺失时定义兜底策略，保证每一轮都能完结。
- 幂等与去重：WS 依赖 `eventId`；resume 通过顺序、`turnSeq` 与本地索引去重，保证多次加载幂等。

## 事件来源与链路

- App Server → 后端（stdin/stdout）：`codex-app-server-protocol` JSON-RPC（不含 `"jsonrpc"` 字段）。
- 后端 bridge：将 ServerNotification/原始通知映射为 `codex/*`，注入 `provider`、`conversationId`、必要时派生额度事件（rate limits）。
- 后端归一化：`codex/*` → 平台层 `chat.*`，进入事件 Ring，附带递增 `eventId` 与 `ts`；供 WS 与 `/debug/codex` 读取。
- resume：从 App Server 持久化的 `rollout-*.jsonl` 解析出事件，直接归一化为 `chat.*` 序列并在服务器侧标注 `turnSeq` 一并返回。

提示：平台层 `chat.*` 是 UI 与 Store 的唯一事实来源；Provider 原始事件仅用于诊断与能力展示。

## Turn 边界：开始与结束事件

统一优先级与兜底策略如下（同时适用于 WS 与 resume）：

- 开始事件（Start）优先级：
  1) `turn.started` 或 `task_started` → 归一化为 `chat.turn.started`
  2) 若缺失，遇到本轮第一条“内容事件”（如 `chat.message.delta`/`chat.reasoning.delta`/任一 `chat.tool.*`）则隐式开始 `beginTurn()`
  3) 再兜底：遇到 `user_message`（来自原始 `event_msg.user_message` 或 `chat.info.user_message`）时推进到下一轮（仅用于 resume 的旧日志兼容）

- 结束事件（End）优先级：
  1) `agent_message` → 归一化为 `chat.message.completed`，并“立即结束当前 turn”（视为该轮的结束锚点）。
  2) 失败/中止：`turn_failed`/`turn_aborted` → 归一化为 `chat.message.failed`/`chat.message.aborted`，并补一次 `chat.turn.complete` 兜底收尾。
  3) `turn.completed`/`task_complete`：作为“确认型”结束事件。若 1) 已结束当前 turn，则该事件只用于落账用量/元信息，重复收尾应当幂等忽略。

注意：结束事件出现后，前端 reducer 必须推进到下一轮并清理本轮的工具索引（tool callId → stepId），避免跨轮污染。

### 乱序与晚到的 `chat.turn.started`

- `chat.turn.started` 不入环（仅作为提示/时间锚点），可能乱序晚到。
- 当 `startedAt` 早于或等于上一轮的 `completedAt` 或最终消息的 `assistant.ts` 时，视为上一轮的补充信号，前端应忽略该 `started`（不得据此新建 Turn）。
- 仅当 `startedAt` 晚于上一轮结束边界时，才开启新一轮（即使缺失显式用户消息，也可由第一条 delta/工具隐式开启）。

## 统一归一化：Provider 原始事件 → `chat.*`

平台层 `chat.*`（部分列举）：
- 文本：`chat.message.delta`、`chat.message.completed`、`chat.message.failed`、`chat.message.aborted`
- 推理：`chat.reasoning.delta`、`chat.reasoning.end`
- 工具：`chat.tool.exec.begin/output/end`、`chat.tool.patch.begin/end`、`chat.tool.mcp.begin/end`
- 回合：`chat.turn.started`（建议新增）、`chat.turn.complete`
- 会话：`chat.session.new`、`chat.session.resumed`、`chat.session.history`（仅首次回放骨架/回退用途）

Provider 常见事件到 `chat.*` 的映射（WS、resume 同源）：
- `task_started`/`turn.started` → `chat.turn.started`
- `task_complete`/`turn.completed` → `chat.turn.complete`
- `turn_aborted` → `chat.message.aborted`（并补 `chat.turn.complete`）
- `turn_failed` → `chat.message.failed`（并补 `chat.turn.complete`）
- `agent_message_delta` → `chat.message.delta`
- `agent_message` → `chat.message.completed`
- `agent_reasoning_delta`/`agent_reasoning` → `chat.reasoning.delta`/`chat.reasoning.end`
- `exec_command_begin/output_delta/end` → `chat.tool.exec.begin/output/end`
- `patch_apply_begin/end` → `chat.tool.patch.begin/end`
  - 注意：Codex 在执行 `apply_patch` 时会先推送 `chat.tool.exec.begin`，随后使用**相同的 `callId`** 发送 `chat.tool.patch.begin/end`。前端/Store 必须用该 `callId` 将已建立的 exec 步骤升级为 patch 步骤，并合并 `changes/adds/dels`、`success` 等补丁元信息；若仅按 first come 记录 exec 而忽略后续 patch 事件，将导致时间线缺失补丁卡片。
- `mcp_tool_call_begin/end` → `chat.tool.mcp.begin/end`
- `token_count` → 不产生 `chat.*`，由后端派生 `codex/account/rateLimits/updated` 更新能力/额度面板

备注：
- WS 路径下，后端在广播时会注入 `eventId` 与 `ts`；前端基于 `method#eventId` 去重。
- resume 路径下，后端生成 `ResumeEventPayload{ method, params }`，并注入 `params.turnSeq`（见下文）。

### 事件映射清单（详尽）

以下列出“原始事件 → 平台层 chat.*”的逐项映射，适用于两条来源：
- WS：App Server Notification（`codex/event/<EventMsg.type>` 或其他 `codex/*`）
- Resume：rollout.jsonl（`event_msg` 与 `response_item`）

统一规则：所有映射后的 `chat.*` 事件均应尽可能包含 `conversationId`、时间戳 `ts`（WS 自动注入），以及在 resume 响应中由服务器注入的 `turnSeq`。

- user_message（event_msg） → chat.info.user_message
  - params：`{ text }`；用于时间线一致性/多端同步；默认不渲染为独立气泡。
  - 用途：旧日志兜底推进 turnSeq。

- task_started | turn.started（event_msg） → chat.turn.started
  - params：`{}`（可按需附带 `model/effort`）。
  - 说明：turn 开始锚点，优先用于计算 turnSeq。

- task_complete | turn.completed（event_msg） → chat.turn.complete
  - params：`{}`（可按需附带 `usage/tokenCount`，推荐另行落到 provider 能力）。

- turn_aborted（event_msg） → chat.message.aborted + chat.turn.complete
  - params：`{}`；为保证收尾，追加一条 `chat.turn.complete`。

- turn_failed（event_msg） → chat.message.failed + chat.turn.complete
  - params：`{ error: { message } }`；为保证收尾，追加一条 `chat.turn.complete`。

- agent_message_delta（event_msg） → chat.message.delta
  - params：`{ delta }`。

- agent_message（event_msg） → chat.message.completed
  - params：`{ text }`。
  - 说明：若同一 turn 连续出现多条 `agent_message`，按出现顺序各自渲染为该 turn 下的独立 assistant 气泡；最后一条视为该 turn 的最终输出。

- agent_reasoning_delta（event_msg） → chat.reasoning.delta
  - params：`{ delta }`。

- agent_reasoning（event_msg） → chat.reasoning.end
  - params：`{ text }`。

- agent_reasoning_section_break（event_msg） → chat.reasoning.section_break（推荐）
  - 现状：若后端未产出该平台事件，可退化为向 `chat.reasoning.delta` 写入分隔符（例如 `"\n\n---\n\n"`）。

- exec_command_begin（event_msg） → chat.tool.exec.begin
  - params：`{ cwd?, command: string[], callId? }`。
  - 补充：resume 还可由 `response_item.function_call(name=="shell")` 产出该事件。

- exec_command_output_delta（event_msg） → chat.tool.exec.output
  - params：`{ callId?, stream: "stdout"|"stderr" (默认 stdout), text }`。
  - 补充：resume 可由 `response_item.function_call_output` 多次产出。

- exec_command_end（event_msg） → chat.tool.exec.end
  - params：`{ callId?, exitCode?, durationMs?, stdout?, stderr? }`。
  - 补充：resume 可由 `response_item.function_call_output.metadata` 聚合得出。

- patch_apply_begin（event_msg） → chat.tool.patch.begin
  - params：`{ callId?, files, autoApproved, firstPath?, adds?, dels?, changes? }`。

- patch_apply_end（event_msg） → chat.tool.patch.end
  - params：`{ callId?, success, stdout?, stderr? }`。

- mcp_tool_call_begin（event_msg） → chat.tool.mcp.begin
  - params：`{ callId, server, tool, arguments? }`。

- mcp_tool_call_end（event_msg） → chat.tool.mcp.end
  - params：`{ callId, server, tool, arguments?, result }`。

- web_search_begin（event_msg） → chat.info.web_search.begin
  - params：`{ callId? }`。
  - 说明：当前实现走 `chat.info.*` 语义步。未来如引入 `chat.tool.search.*` 可平滑替换。

- web_search_end（event_msg） → chat.info.web_search.end
  - params：`{ callId?, query? }`。

- plan_update（event_msg） → chat.info.plan_update
  - params：`{ title?, body?, items? }`（按平台定义）。

- turn_diff（event_msg） → chat.info.turn_diff
  - params：`{ diff }`（unified diff 字符串）。

- exec_approval_request / apply_patch_approval_request（event_msg） → chat.info.approval.exec / chat.info.approval.patch（入环）
  - params（exec）：`{ callId?, command?: string[], cwd?: string, reason?: string }`
  - params（patch）：`{ callId?, reason?: string, grantRoot?: string, changeCount: number }`
  - 说明：当前实现已入环并用于 UI 提示，符合 SSoT“信息与元提示入环可补偿”的约定。

- token_count（event_msg）
  - 说明：不映射 `chat.*`；由后端派生 `codex/account/rateLimits/updated` 更新额度面板与能力。

- codex/sessionConfigured（notification）
  - 说明：Provider 层事件；不映射 `chat.*`。后端可在首次 resume/new 之后另行广播 `chat.session.resumed/new` 与 `chat.session.history` 作为骨架。

- codex/account/rateLimits/updated（notification）
  - 说明：Provider 能力事件；不映射 `chat.*`；用于 UI 额度/限流展示。

## resume JSONL → `chat.*` 的解析规则

- 行类型：
  - `session_meta`：会话元信息（conversation_id 等），不直接产出 `chat.*`。
  - `turn_context`：回合上下文（模型、审批策略、沙箱、cwd、effort、summary），用于 resume 的配置回显，不直接产出 `chat.*`。
  - `event_msg`：核心事件（与 WS 的 `codex/event/*` 同源）。按上节映射产出 `chat.*`；其中：
    - `user_message`：用于“旧日志兜底”的 turn 递增；本身可映射为 `chat.info.user_message`（供时间线一致性/多端同步展示，默认不渲染独立气泡）。
    - `agent_message/agent_message_delta/agent_reasoning*`、`exec_*`、`patch_*`、`mcp_tool_*`、`task_*`、`turn_*`：按映射产出对应 `chat.*`。
  - `response_item`：侧重工具调用/输出聚合（如 `function_call`/`function_call_output`）。后端需：
    - 解析 `function_call(name=="shell")` → `chat.tool.exec.begin`（含 `command[]/cwd/callId`）
    - 解析 `function_call_output` → `chat.tool.exec.output`（stdout 片段）与 `chat.tool.exec.end`（根据 metadata 生成 `exitCode/durationMs/stdout/stderr`）

### 简化回退规则（仅当缺少 turn 事件时）

- 在旧日志或极简轨迹下，可将一次 turn 近似理解为：从一条 `user_message` 开始，到下一条 `agent_message` 结束；两者之间的所有事件（`agent_message_delta`、`agent_reasoning_*`、`exec_*`、`patch_*`、`mcp_tool_*` 等）即为该 turn 的 Working 时间线。
- 注意：“下一行即 AI 的第一次响应”并非严格保证。`user_message` 之后常见先出现 `task_started/turn.started`、`agent_reasoning_delta` 等，再到 `agent_message_delta`。上述事件都属于该 turn 的步骤序列。
- 若出现连续多条 `agent_message`：每一条都“结束一个 turn”。规则为：
  - 若当前存在未结束的 turn，则本条 `agent_message` 结束该 turn；
  - 若当前没有打开的 turn，则先隐式 `beginTurn()`，随后用本条 `agent_message` 立即结束该 turn；
  - 因此，连续 `agent_message` 将形成连续的多个 turn，每个 turn 渲染一个独立的 assistant 气泡。
  - 流式约定：`agent_message_delta` 归属于“当前打开的（尚未完成的）assistant 气泡”。一旦 `agent_message` 抵达，立即完成该气泡并结束 turn。

- turnSeq 标注（可选，Resume 友好）：
  - 含义：服务端为每条 `chat.*` 标注“所属第几轮”（从 1 开始），仅用于 Resume 快速、幂等地落位事件；WS 不需要。
  - 计算建议：优先依据 `turn.started`/`task_started` 递增；缺失时遇到 `user_message` 递增；`agent_message` 结束当前 turn 后，下一条内容事件（含连续的下一条 `agent_message`）归入下一轮。
  - 可选性：若服务端未提供 `turnSeq`，前端可按本文“开始/结束事件优先级 + 简化回退规则”自行重建轮次，渲染结果一致。

- 收尾补全：
  - 若某次解析到达 EOF 仍未遇到结束事件，且已出现 `chat.message.completed/failed/aborted`，则后端或前端应触发兜底 `completeTurn()`，确保该轮能完结。

## 前端消费（与 turn-first reducer 对齐）

基于本文“前端数据模型与 Store API”：
- Turn 合并：
  - 接到 `chat.turn.started` 或首条内容事件 → `beginTurn()`；
  - 期间的 `chat.message.*`/`chat.reasoning.*`/`chat.tool.*` 全部归入当前 turn；
  - 接到 `chat.message.completed/failed/aborted` → `completeTurn()`；若随后收到 `chat.turn.complete`，属于确认型事件，应幂等处理。
  - 连续 `chat.message.completed` 表示连续多个 turn：每次 `chat.message.completed` 都结束当前 turn；如无打开的 turn，则先隐式 `beginTurn()` 再结束。
- Step 聚合：
  - 以 `callId` 索引工具步骤：`begin` 建立，`output` 追加，`end` 收尾；turn 完成后清理工具索引。
- 幂等：
  - WS：以 `method#eventId` 去重，忽略旧 `eventId`；允许同一 `eventId` 下不同 `method` 的帧交错到达。
  - resume：按输入顺序 + `turnSeq` + 本地 step 索引（如 `callId`）做幂等合并；`loadSnapshot()` 可重复调用。

## 推荐的 Resume 接口契约（后端）

- 路径：`POST /api/chat/conversations/resume`
- 返回（建议形态）：
```jsonc
{
  "conversationId": "...",
  // 可选：仅用于首屏骨架/回退（有 events 时前端以事件为准）
  "history": [ { "role": "user|assistant|reasoning", "text": "...", "reasoning": "..." } ],
  // 归一化后的平台层事件序列（可包含 turnSeq；缺失时前端可自算）
  "events": [
    { "method": "chat.turn.started", "params": { "turnSeq": 1 } },
    { "method": "chat.reasoning.delta", "params": { "delta": "...", "turnSeq": 1 } },
    { "method": "chat.message.delta", "params": { "delta": "...", "turnSeq": 1 } },
    { "method": "chat.tool.exec.begin", "params": { "callId": "...", "command": ["bash","-lc","..."], "turnSeq": 1 } },
    { "method": "chat.message.completed", "params": { "text": "最终答案", "turnSeq": 1 } },
    { "method": "chat.turn.complete", "params": { "turnSeq": 1 } }
  ],
  // 可选：resume 的配置回显（模型/审批/沙箱/CWD/effort/summary/overrides）
  "config": { }
}
```

实现要点（后端）：
- 为 `agent_message` 补产 `chat.message.completed`；为 `agent_message_delta` 产出 `chat.message.delta`；
- 将 `task_started/turn.started` → `chat.turn.started`；`task_complete/turn.completed` → `chat.turn.complete`；
- `turn_aborted/turn_failed` → `chat.message.aborted/failed` 并补一次 `chat.turn.complete`；
- `function_call(function==shell)`/`function_call_output` 解析为 exec 工具三态事件；
- 所有归一化事件附带 `params.turnSeq`。

### 兼容与约束（重要）

- exec 输出只在“已知开始”时产生：
  - 仅当该 `callId` 已通过 `function_call(name=="shell")` 或 `exec_command_begin` 记录到 `exec_calls` 集合时，才会产出 `chat.tool.exec.output/end`；
  - 若遇到 `exec_command_output_delta` 而缺少 begin，后端将补一条占位 `chat.tool.exec.begin`（无 command/cwd），以便前端能够聚合到同一 Step 中；
  - 该策略避免 resume 出现“没有 begin 的孤立 output”导致前端无法渲染步骤。

- MCP 的 response_item 兼容：
  - 对于仅出现 `response_item.function_call`/`function_call_output` 而无 `mcp_tool_call_*` 的日志：
    - `function_call(name 形如 mcp__...)` → `chat.tool.mcp.begin`（解析 arguments 中的 `server/tool/arguments`）；
    - `function_call_output` → `chat.tool.mcp.end`（`result` 优先解析为 JSON，失败则直接用字符串）；
  - 若存在残留的未收尾 MCP 调用（EOF），后端会补一条 `chat.tool.mcp.end(result=null)`。

- plan_update：
  - WS 路径：`codex/event/plan_update` → `chat.info.plan_update`，前端以 `step.kind='plan'` 渲染；
  - Resume 路径：支持两类来源的归一化：
    - `event_msg.plan_update` → `chat.info.plan_update`；
    - `response_item.function_call(name=="update_plan")`（arguments 含 `plan`/`explanation`）→ `chat.info.plan_update`；
    - 两者均不强制开启新 Turn，若当前有进行中的 Turn，则附加到当前 `turnSeq`；否则作为信息附加（无 `turnSeq`）。

## 例：跨源一致事件序列（摘要）

- WS（App Server Notification → 后端 → `chat.*`）：
  1) `codex/event/task_started` → `chat.turn.started`
  2) `codex/event/agent_reasoning_delta` → `chat.reasoning.delta`
  3) `codex/event/agent_message_delta` → `chat.message.delta`
  4) `codex/event/agent_message` → `chat.message.completed`
  5) `codex/event/task_complete` → `chat.turn.complete`

- Resume（rollout.jsonl → 后端 → `chat.*`）：
  1) `event_msg.task_started` → `chat.turn.started`（turnSeq=1）
  2) `event_msg.agent_reasoning_delta` → `chat.reasoning.delta`（turnSeq=1）
  3) `response_item.function_call(shell)` → `chat.tool.exec.begin`（turnSeq=1）
  4) `response_item.function_call_output` → `chat.tool.exec.output/end`（turnSeq=1）
  5) `event_msg.agent_message` → `chat.message.completed`（turnSeq=1）
  6) `event_msg.task_complete` → `chat.turn.complete`（turnSeq=1）

两条链路产出的 `chat.*` 序列同构，前端按同一 reducer 合并为 1 个 Turn：用户气泡 + AI 气泡（正文 + 折叠 Reasoning + 折叠 Working/Steps）。

## 幂等、去重与容错

- WS：以 `eventId` 为单调游标；严格忽略小于最近 `eventId` 的事件；允许不同 `method` 的同 `eventId` 帧交错到达。
- Resume：
  - 没有 `eventId`，依赖“顺序 + `turnSeq` + 工具索引（如 `callId`）”实现幂等；
  - 解析 EOF 且未遇到结束事件时，若已有 `chat.message.completed/failed/aborted`，触发兜底 `completeTurn()`；
  - 旧日志缺少 `turn.started/turn.completed` 时，使用 `user_message` 驱动 `turnSeq` 递增，保证可恢复。

## 实施步骤建议（后端为先）

1) 补齐 resume 归一化映射：为 `agent_message(_delta)`、`task_*`、`turn_*` 产出完整的 `chat.*`；
2) 标准化 `turnSeq`：优先 `turn.started/task_started`，兜底 `user_message`；写入所有事件 `params.turnSeq`；
3) 前端仅消费 `events`（`chat.*`）进行重放，`history` 仅作无事件时的回退与骨架；
4) 文档与调试：使用 `/debug/codex?includeChat=true` 对比原始与归一化事件，验证 turn 边界一致性。

---

该文档作为“WS 与 Resume 统一 SSoT”的权威约定，指导后端映射完善与前端 turn-first 改造；配合本文“前端数据模型与 Store API”的 reducer 规则落地，可移除对历史结构的强依赖，降低维护成本。

---

## 前端数据模型（Turn/Step）与 Store API（权威）

统一 Turn-first 模型（节选，详见 `packages/web/src/features/codex-chat/stores/chat-turns.ts`）：

```ts
type TurnStepKind = 'read'|'list'|'search'|'exec'|'patch'|'mcp'|'info'|'thinking'|'plan'
type TurnStepStatus = 'streaming'|'completed'|'failed'|'aborted'
type TurnStatus = 'streaming'|'completed'|'failed'|'aborted'

type TurnStep = { id: string; kind: TurnStepKind; title: string; body?: string; tags?: string[]; status: TurnStepStatus; ts: string; meta?: any }
type Turn = {
  id: string; seq: number; conversationId?: string; startedAt?: string; completedAt?: string; status: TurnStatus;
  user: { text: string; ts: string }; assistant: { text: string; ts?: string };
  reasoning?: { title?: string; content: string }; steps: TurnStep[];
  meta?: { working?: boolean; workingTitle?: string; model?: string; tokenCount?: any; extra?: any }
}
```

关键不变式：
- 单轮渲染：每个 Turn = 1 用户气泡 + 1 AI 气泡；Reasoning 与工具步骤聚合在该 AI 气泡内。
- 边界：`chat.turn.started` 开始，`chat.turn.complete` 结束；缺失时以 `chat.message.completed|failed|aborted` 兜底收尾。
- 工具聚合：以 `callId` 追踪 step，`begin` 建立、`output` 追加、`end` 收尾；turn 完成时清理索引。
- 去重元数据：当 `chat.message.completed` 落地时，把事件 `eventId` 写入 `turn.meta.extra.assistantCompletedEventId`，供 Rx 微批在收到迟到的 `chat.message.delta` 时比对（仅当 `eventId` 更新或正文追加新尾段时才写入），防止重复 turn。

Store API（面向事件，简要）：
- 会话：`setConversationId`、`reset`
- Turn：`markTurnStarted(opts?)`、`completeTurn()`
- 用户/助手：`setUserText(text)`、`appendAssistantDelta(delta)`、`completeAssistant(text?)`、`failAssistant(msg?)`、`abortAssistant()`
- Reasoning：`appendReasoning(delta)`、`endReasoning(summary)`（`title=summarizeFirstLine(summary)`）
- 步骤：`addStep(kind, callId, title, {meta,tags,status,body})`、`appendStep(callId, text)`、`endStep(callId, patch)`
- 快照：`loadFromHistory(history)`、`loadSnapshot(history, events)`（events 为归一化后的 `chat.*` 序列）

事件分配到 Turn 的规则：
- 游标法顺序回放；遇到“结束事件”推进下一 Turn；否则归当前 Turn。
- 结束事件：`chat.turn.complete`、`chat.message.completed|failed|aborted`。
- 开始事件：`chat.turn.started`（可选）；若缺失，则第一条 delta/工具/信息到来时自动 `beginTurn()`。

## 性能与渲染建议（流式优化）

来自历史统一化文档的经验沉淀：
- RxJS 微批：对高频 `chat.message.delta` / `chat.reasoning.delta` 做 `bufferTime(≈16ms)` 再写入 Store（测试环境可关闭），明显减少 setState 次数。
- 事件去重：对 `codex/event/*` 使用 `method#eventId` 粗粒度去重；允许相同 `eventId` 的不同 `method` 帧。
- Streaming 阶段渲染简化：不做重度 Markdown 拆块/高亮；完成后再做完整解析。
- 历史回放：首屏仅在本地无 turns 时落 `chat.session.history` 骨架，避免“新会话 + initialMessages”重复。
- 读类优化：仅保留“read 的连续合并”（同一文件相邻/重叠行段合并）；移除旧 explored 聚合策略。
