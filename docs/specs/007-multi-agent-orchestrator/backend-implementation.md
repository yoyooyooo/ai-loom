# 后端实现（Orchestrator + Codex 适配）

## 组件划分

- Codex 客户端（已有）：`packages/rust/crates/ailoom-executors/src/providers/codex/client.rs`
  - `new_conversation`、`resume_conversation`、`add_conversation_listener/ensure_listener`、`send_user_message`、`interrupt_conversation`。
- 归一化桥（已有）：`packages/rust/crates/ailoom-executors/src/providers/codex/bridge.rs`
  - `codex/event/*` → `chat.*`；附 `conversationId` 与 `provider:'codex'`；入 Ring（持久）与 `broadcast_ephemeral`（瞬时）。
- WS Hub/Ring（已有）：`ws/hub.rs`、`ws/methods.rs`
  - 注入 `eventId/ts`；支持 `events.resume({ topic:'chat', filter:{ conversationId, providerId? } })`。
- Orchestrator（新增）：`services/orchestrator/`
  - 订阅 Hub（`subscribe()`）、解析有界指令块、执行 spawn/send/stop、广播 `chat.agent.spawned|report|status`。

## Orchestrator 核心流程（伪码）

```rust
loop events from hub.subscribe() {
  if ev.method == "chat.message.completed" {
    let text = ev.params["text"].as_str().unwrap_or("");
    if let Some(directives) = extract_directives(text) { // <<<orchestrator ... >>>
      for d in directives {
        match d.action {
          "spawn" => handle_spawn(parent_cid, d),
          "send"  => handle_send(d),
          "stop"  => handle_stop(d),
          "report"=> handle_report(parent_cid, d),
          _ => {}
        }
      }
    }
  }
}
```

### 指令解析

- `extract_directives(text) -> Option<Vec<Directive>>`
  - 正则/扫描找到首个 `<<<orchestrator` 到 `>>>` 的块；截取上限（例如 16KB）。
  - JSON 解析为对象或数组；校验 `action` 字段；失败则忽略并可广播 `chat.agent.status{ status:'failed', reason:'invalid_directive' }`。

### spawn 动作

```rust
fn handle_spawn(parent_cid: &str, d: SpawnDirective) {
  // 幂等：按 (parent_cid, trigger_event_id, correlation_id?) 去重
  if processed.contains(key) { return }

  // 1) 生成子会话
  let params = NewConversationParams {
    model: d.agent.model, 
    base_instructions: d.agent.system_prompt,
    include_apply_patch_tool: Some(d.agent.tools.apply_patch),
    include_plan_tool: None, // 避免与指令块耦合
    ..Default
  };
  let resp = codex.new_conversation(params).await?;
  let child_cid = resp.conversation_id;

  // 2) 监听子会话
  codex.ensure_listener(&child_cid).await?;

  // 3) 投递首条目标消息
  let mut goal = d.goal.clone();
  if let Some(h) = d.handoff { goal = format!("{}\n\n[context]\n{}", goal, h.context); }
  codex.send_user_message(child_cid.clone(), goal).await?;

  // 4) 广播父会话锚点
  hub.broadcast("chat.agent.spawned", json!({
    "conversationId": parent_cid,
    "childConversationId": child_cid,
    "provider": "codex",
    "agentId": d.agent.id,
    "purpose": d.goal,
  }));

  processed.insert(key);
}
```

### send/stop/report 动作

- send：`codex.send_user_message(d.to, d.text)`；若 `to` 是 `agentId`，需在映射表中查找其 `childConversationId`。
- stop：`codex.interrupt_conversation(target)`。
- report：`hub.broadcast("chat.agent.report", { conversationId: parent, fromConversationId: child, agentId, text, refs })`。

## 存储与幂等（可选）

- 轻量表 `agent_links`：
  - `parent_cid`、`child_cid`、`agent_id`、`provider`、`created_at`、`correlation_id`、`trigger_event_id`。
- 轻量表 `processed_triggers`：
  - `(parent_cid, event_id, correlation_id)`；适配器启动时加载到内存 Set；达到容量阈值时按时间淘汰。

## 配置与 Profile

- `.ailoom/agents.json`（或 UI 配置页）：
  - `[{ id, title, provider, model, systemPrompt, tools:{ exec, patch, mcp? }, limits:{ maxTurns, timeoutSec } }]`
  - Orchestrator 在 `spawn` 时优先匹配 `agent: string` 到 profile；`inline` 形式用于覆盖。

## 可观测性

- 日志：`orchestrator` 目标；记录 spawn/send/stop/report 的输入/输出与用时；错误时带父/子 cid。
- 事件：`chat.agent.status` 用于 UI 呈现与调试（如 `budget_exceeded`、`invalid_directive`）。

## 兼容性与风险

- 归一化/渲染不变：仅新增信息类事件；所有 `chat.message.*`/`chat.reasoning.*`/`chat.tool.*` 行为保持一致。
- Ring 压力：多子会话并发会增量事件量；建议支持 `AILOOM_WS_RING_CAP` 适当调大，并对工具输出做节流。
- 安全策略：沿用 `approvalPolicy/sandbox`；禁止子会话放宽权限；必要时提供白名单模型/目录。
