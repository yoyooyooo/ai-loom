# 004 — Chat 多会话并行与按会话 Resume 方案

## 原始需求描述（提炼）

面向非技术口径，说明“我们要实现什么、用户将如何使用、哪些不做”。

- 页面与导航
  - 提供 `/chat` 与 `/explore` 两个顶级入口。
  - `/chat` 采用双栏：左侧历史列表、右侧聊天；能发送/停止、从历史恢复并继续对话。
  - `/explore` 保持现有三栏（活动栏/目录树/编辑器），能力不回退。

- 历史与恢复
  - 左侧展示会话历史（最近在前），支持“加载更多”；每条显示预览与时间。
  - 点击历史项即可“恢复到该会话”，从此刻起继续对话，不回放历史消息；页面显示“已恢复到历史会话”的提示。
  - 恢复失败时给清晰错误提示，保持当前会话可继续输入与停止。
  - 若当前正在生成，点击恢复需二次确认；确认后先中止生成再切换；取消则维持原状。

- 多会话并行（阶段性目标）
  - 同一页面将来可以同时打开至少两条会话，互不干扰；本阶段先完成“事件层隔离 + 按会话恢复”的打底，不强制并行渲染多个面板。

- 时间线与 Thinking（与统一化文档一致）
  - 正常对话与恢复后的展示一致：回答与“Reasoning 总结”进入时间线；工具步骤（exec/patch/mcp/read/search）以“摘要行 + 可展开正文”。
  - 推理增量（thinking delta）仅用于“Working/Thinking …”实时状态，不入时间线、不落盘；终结（summary）进入时间线，刷新后可从 JSONL 恢复。

- 非目标/有意隐藏
  - 不默认展示 raw reasoning、token 计数、review 事件；必要时以后端/前端开关显式开启，默认仍隐藏。

- 验收要点（用户角度）
  - 2 步内完成“打开历史 → 恢复成功”，有明显提示。
  - 生成中保护有效；失败提示清晰，原会话可继续。
  - 刷新后仍能“停止生成”，但不自动回放历史；恢复与实时展示一致。
  - （并行预留）事件层具备按 `conversationId` 的隔离；未来打开两会话时互不串扰。

## 背景与问题

当前 Hub 为所有 WS 事件分配一个全局自增 `eventId` 并写入单一 ring；客户端常用单个 `lastEventId` 做 `events.resume({ after })`。当需要“多会话并行 + 隔离”时：

- 全局 `lastEventId` 不足以恢复每条会话的 backlog，因为不同会话事件在全局 ring 交错；用一个游标会跳过其他会话在该游标之前的未读事件。
- 现有 `events.resume` 不支持 `conversationId` 过滤；即使客户端收到全量再丢弃，成本高且易错。

因此，需要“按会话的断点游标 + 按会话过滤的 resume”。

## 目标

- 支持“多活跃会话 + 隔离 + 同时运行”。
- 每会话独立恢复 backlog：断线/刷新后仅拉取该会话的未读事件。
- 与已定义的时间线/Thinking 规范一致：
  - 增量只用于实时（底部 Thinking / exec.output 等），尽量通过 ring 续播补齐。
  - 终结项（回答与 Reasoning 总结）通过 JSONL/resume 与 WS 共同还原。

> 备注：本节“目标”与上述“原始需求描述”相互呼应——前者强调传输/断点策略，后者强调用户体验与边界。

## 方案总览

1) 服务端：在 Hub 存储/恢复路径注入 `conversationId`，扩展 `events.resume` 支持 `topic+filter`。
2) 客户端：维护“每会话 lastEventId（convLastId）”并在重连时对每条活跃会话分别执行 resume。
3) 兼容默认单会话：不带 filter 时行为与现在一致。

---

## 服务端改造

文件：`packages/rust/ailoom-server/src/ws/hub.rs`、`.../ws/methods.rs`、`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs`

- EventRecord 增加 `conversation_id: Option<String>`：
  - 在 `Hub::broadcast(method, params)` 中，从 `params.conversationId`（若存在）提取并写入 `EventRecord`。
  - 其它主题（file/tree/annotations）留空。

- `events.resume` 扩展签名（向后兼容）：
  - 现状：`{ after?: number, tail?: number }`。
  - 新增（可选）：`{ topic?: 'chat'|'file'|'tree'|'annotations', filter?: { conversationId?: string } }`。
  - 语义：当 `topic='chat'` 且 `filter.conversationId` 存在时，仅返回 `conversation_id` 匹配的事件；否则沿用原逻辑。

- 伪代码（仅示意）：
```rust
// hub.rs
pub struct EventRecord { id: u64, method: String, params: Value, conversation_id: Option<String> }

// methods.rs
match method {
  "events.resume" => {
    let after = parse_after(params);
    let topic = params.get("topic").and_then(|v| v.as_str()).unwrap_or("");
    let conv  = params.get("filter").and_then(|f| f.get("conversationId").and_then(|v| v.as_str()));
    let (events, truncated) = if topic == "chat" && conv.is_some() {
      hub.resume_after_filtered(after, |e| e.conversation_id.as_deref() == conv)
    } else {
      hub.resume_after(after)
    };
    // 封装成 JSON-RPC 通知列表返回
  }
  _ => {}
}
```

- Ring 策略建议：
  - 仍使用单 ring，但恢复时按 `conversation_id` 过滤；若后续量大，可为 chat 引入“每会话 ring cap”或索引（`HashMap<convId, VecDeque<pos>>`）。
  - ephemeral 事件（如计划的 `chat.turn.started`）不入 ring，不参与 resume。

## 客户端改造

文件：`packages/web/src/lib/ws/rx-client.ts`、`.../features/codex-chat/services/ws.ts`、`.../features/codex-chat/stores/chat.ts`

- 维护“每会话 lastEventId”：
  - 数据形态：`convLast: Record<string /*conversationId*/, number /*eventId*/>`。
  - 更新规则：收到任意 `chat.*` 事件，若 `eventId` 大于当前存储值，则写回 `convLast[cid]=eventId` 并持久化（localStorage）。

- 重连/冷启动时：
  - 对每个“活跃/最近使用”的会话分别调用：
    ```json
    {"jsonrpc":"2.0","id":1,"method":"events.resume","params":{
      "after": 12345,
      "topic": "chat",
      "filter": {"conversationId": "conv-1"}
    }}
    ```
  - 回放返回的 `events[]`，仅 chat.*；其它主题按现有逻辑保留（可用 `VITE_WS_RESUME=1` 开关）。

- UI 对齐：
  - Timeline：按事件顺序恢复 exec/patch/mcp/read/search 等详情条目；多会话各自独立恢复。
  - Thinking：仍只吃增量（`chat.reasoning.delta`）；终结（`chat.reasoning.end`）进入时间线；若无增量，直到下一条 delta 到达前可能不显示占位（或配合 `chat.turn.started` 显示）。

## 请求/响应示例

请求（按会话恢复）：
```json
{"jsonrpc":"2.0","id":1,"method":"events.resume","params":{
  "after": 98765,
  "topic": "chat",
  "filter": {"conversationId": "conv-abc"}
}}
```

响应：
```json
{
  "jsonrpc":"2.0",
  "id":1,
  "result":{
    "events":[
      {"jsonrpc":"2.0","method":"chat.tool.exec.begin","params":{ "conversationId":"conv-abc", "eventId":"98766", "...": "..." }},
      {"jsonrpc":"2.0","method":"chat.message.delta","params":{ "conversationId":"conv-abc", "eventId":"98767", "delta":"..." }}
    ],
    "truncated": false
  }
}
```

## 一致性与兼容

- 单会话情况下，客户端可继续使用“全局 lastEventId + 不带过滤”的 resume；或直接不对 chat 续播，仅依赖 HTTP resume（保持当前行为）。
- 多会话并行时，建议始终使用“按会话 resume”。

## 性能与风控

- 内存：单 ring + 过滤的策略简单；事件量上升后可引入“每会话 ring cap 或索引”。
- 截断：若 `truncated=true`，UI 轻提示“早期增量已截断”；最终回答/Reasoning 仍可由 JSONL 恢复。
- 安全：raw reasoning、token_count、review 转发默认关闭（见 Timeline 统一化文档）。

## 迁移步骤（建议）

1. 后端：为 EventRecord 注入 `conversation_id`；扩展 `events.resume` 支持 `topic+filter`。
2. 前端：引入 `convLast` 持久化与“按会话 resume”调用，behind flag；保留现有逻辑为回退。
3. 调整 WS 订阅：当切换会话或新增会话时，建立/更新该会话的订阅与断点。
4. 验收：断网/刷新/多会话并发下，timeline/Thinking/工具输出的一致性对比通过。

## 验收用例

- 用例 1：两条会话 A/B 并发生成，刷新后 A/B 各自恢复至刷新前状态（回答增量/exec.output 恢复到近期；Thinking 需等下一条 delta）。
- 用例 2：仅 A 活跃，B 空闲；刷新后仅恢复 A；不误播 B 的 backlog。
- 用例 3：ring 截断：resume 返回 `truncated=true`，UI 轻提示；最终回答与 Reasoning 总结一致。
- 用例 4：关闭 raw/token/review 开关，历史与实时视觉一致；开启 raw 后（实验），raw 终结可在时间线折叠展示。

---

附：与 Turn-first SSoT 的关系

- 本文专注“多会话 + 按会话 resume”的传输层与断点策略；渲染/事件边界规范详见 `docs/guide/codex-chat-turn-ssot.md`。
- 两者配合可保证：
  - 实时 ↔ 恢复一致（除去仅实时的增量与本地 UI 状态）。
  - 多会话隔离（订阅与断点均按会话）。
