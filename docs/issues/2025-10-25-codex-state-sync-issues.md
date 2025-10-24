# Codex 集成状态同步问题分析

**日期**：2025-10-25
**分析范围**：Codex 任务生命周期管理、前后端状态同步、中断机制
**严重程度**：高危

---

## 问题概述

在 AI-Loom 项目的 Codex 集成中发现多个可能导致**界面无法即时反馈任务结束**或**无法正常终止 Codex 执行任务**的关键问题。这些问题主要涉及：

1. 前端中断时的乐观更新策略不当
2. WebSocket 重连时关键事件不可恢复
3. 后端 interrupt 响应缺少状态信息
4. generating 状态计算缺少容错机制

---

## 🔴 高危问题

### 问题 A：前端中断时状态同步不可靠

**严重程度**：🔴 高危
**文件位置**：`packages/web/src/features/codex-chat/components/chat-panel.tsx:61-68`

#### 问题代码

```typescript
async function onStop() {
  if (!conversationId) return
  try {
    await chatApi.interrupt(conversationId)
  } finally {
    chatActions.abortAssistantMessage() // ⚠️ 致命缺陷
  }
}
```

#### 根本原因

1. **乐观更新策略失当**：无论 `interrupt` API 成功与否，`finally` 块都会立即执行 `abortAssistantMessage()`
2. **未等待服务端确认**：没有等待 `chat.message.aborted` 事件到达，直接修改本地状态
3. **状态不一致风险**：
   - 场景 1：interrupt HTTP 请求失败（网络超时、服务器错误），但前端已标记为 aborted，**后端仍在生成**
   - 场景 2：interrupt 成功发送，但 WebSocket 临时断线，`turn_aborted` 事件丢失
   - 场景 3：interrupt 处理中后端又推送新的 `message.delta`，前端已停止接收

#### 影响

- 用户点击"停止生成"后 UI 立即显示已停止
- 实际上 Codex 可能仍在后台运行消耗资源
- WebSocket 继续接收 delta 事件，但前端不再渲染（因为 `generating=false`）
- 用户误以为任务已终止，无法感知后端异常

#### 修复建议

```typescript
// 移除乐观更新，等待服务端事件确认
async function onStop() {
  if (!conversationId) return

  try {
    await chatApi.interrupt(conversationId)
    // ✅ 不再立即调用 abortAssistantMessage()
    // ✅ 等待 chat.message.aborted 事件到达后由 ws.ts 自动触发
  } catch (error) {
    // ❌ interrupt 失败，保持 generating 状态，提示用户
    console.error('中断失败', error)
    alert('停止生成失败，请重试')
  }
}
```

---

### 问题 B：WebSocket 重连时 chat.* 事件不可恢复

**严重程度**：🔴 高危
**文件位置**：`packages/web/src/lib/ws/rx-client.ts:191-198`

#### 问题代码

```typescript
// 仅对文件/树/批注做补发；跳过 chat.*，避免刷新后对话历史重播
if (m === 'file.changed' || m === 'tree.changed' || m.startsWith('annotations.')) {
  const eid = parseEventId(ev?.params)
  if (eid && eid > this.lastEventId) this.lastEventId = eid
  this.eventsSubject.next({ method: m, params: ev?.params })
}
// ⚠️ chat.* 事件被跳过，不会 resume
```

#### 根本原因

1. **设计权衡导致的缺陷**：为避免刷新页面后重播全部对话历史，`chat.*` 事件被排除在 resume 机制之外
2. **缺少状态恢复机制**：断线重连后，如果错过 `turn_complete`/`turn_aborted`，前端无法得知任务已结束
3. **generating 状态永久卡死**：网络抖动导致临时断线，关键终止事件丢失，`generating=true` 无法恢复

#### 影响

- 网络抖动（WiFi 切换、移动网络波动）导致 WebSocket 临时断开
- `turn_complete` 或 `turn_aborted` 事件在断线期间到达，resume 时被跳过
- 前端 `generating` 状态永久为 `true`
- 用户看到"停止生成"按钮一直显示，textarea 被禁用，无法发送新消息
- **唯一解决方法**：刷新页面（但会丢失当前会话上下文）

#### 修复建议（三个方案）

**方案 1：超时兜底（推荐，简单有效）**

```typescript
useEffect(() => {
  if (!generating) return

  // 30 秒未收到任何事件，强制标记完成
  const timer = setTimeout(() => {
    console.warn('生成超时，自动标记完成')
    chatActions.completeAssistantMessage()
    chatActions.finalizeAllToolCards()
    chatActions.finalizeExploreCard()
  }, 30000)

  return () => clearTimeout(timer)
}, [generating])
```

**方案 2：添加"强制停止"按钮**

```typescript
{generating && (
  <button onClick={() => {
    if (window.confirm('强制重置会清空当前会话状态，确定吗？')) {
      chatActions.reset()
    }
  }}>
    强制重置
  </button>
)}
```

**方案 3：选择性恢复终止事件**

```typescript
// 在 tryResume() 中允许恢复终止事件
if (m === 'chat.turn.complete' || m === 'chat.message.aborted' || m === 'chat.message.failed') {
  this.eventsSubject.next({ method: m, params: ev?.params })
}
```

---

## 🟡 中危问题

### 问题 C：后端 interrupt 响应缺少状态信息

**严重程度**：🟡 中危
**文件位置**：`packages/rust/ailoom-server/src/routes/chat/interrupt.rs:16`

#### 问题代码

```rust
let _ = app.interrupt_conversation(conversation_id).await; // ⚠️ 返回值被忽略
(StatusCode::OK, "ok").into_response() // ⚠️ 总是返回成功
```

#### 根本原因

1. **返回值被忽略**：虽然 `interrupt_conversation()` 等待 JSON-RPC 响应，但结果被 `let _` 丢弃
2. **HTTP 响应无区分度**：总是返回 `200 OK`，无法告知前端 interrupt 是否真正成功
3. **完全依赖事件推送**：后端不主动广播终止状态，仅依赖 Codex 推送 `turn_aborted` 事件

#### 修复建议

```rust
match app.interrupt_conversation(conversation_id.clone()).await {
    Ok(_) => {
        tracing::info!(target:"codex", conversationId=%conversation_id, "interrupt succeeded");
        (StatusCode::OK, Json(json!({"status": "interrupted"}))).into_response()
    }
    Err(e) => {
        tracing::error!(target:"codex", conversationId=%conversation_id, error=%e, "interrupt failed");
        (StatusCode::BAD_GATEWAY, Json(json!({
            "status": "failed",
            "error": e.to_string()
        }))).into_response()
    }
}
```

---

### 问题 D：generating 状态计算的单向依赖

**严重程度**：🟡 中危
**文件位置**：`packages/web/src/features/codex-chat/stores/chat.ts:72-81`

#### 问题代码

```typescript
function recalcGenerating(
  messages: ChatMessage[],
  toolCards?: Record<string, { id: string; title: string }>
): boolean {
  const toolIds = toolCards ? new Set(Object.values(toolCards).map((e) => e.id)) : new Set<string>()
  return messages.some((m) => {
    if (toolIds.has(m.id)) return false
    return (m.role === 'assistant' || m.role === 'reasoning') && m.status === 'streaming'
  })
}
```

#### 根本原因

1. **仅依赖本地消息状态**：不考虑 WebSocket 连接状态、conversationId 有效性等外部因素
2. **缺少超时兜底**：没有"如果 X 秒未收到事件，自动标记为完成"的保护机制
3. **假设事件必达**：完全依赖 `turn_complete`/`turn_aborted` 一定会到达
4. **无手动恢复机制**：没有提供"强制重置"按钮让用户手动修复状态

#### 影响

一旦终止事件丢失（问题 B），用户无法恢复正常交互，没有任何自动或手动恢复机制。

---

## ✅ 正向设计亮点

1. **后端事件映射完整**：bridge.rs 正确映射了所有 Codex 终止事件
2. **Hub 广播机制健壮**：自动添加 eventId/ts，支持优先级，有 ring buffer
3. **前端事件分发正确**：ws.ts 完整处理所有 chat.* 事件

---

## 📊 修复优先级

| 问题 | 优先级 | 复杂度 | 估计工时 | 风险 |
|------|--------|--------|----------|------|
| 问题 A | P0 | 低 | 2h | 低 |
| 问题 B - 方案 1 | P0 | 低 | 1h | 低 |
| 问题 B - 方案 2 | P1 | 低 | 1h | 低 |
| 问题 C | P1 | 低 | 2h | 低 |
| 问题 D（可观测性） | P2 | 低 | 3h | 低 |

**建议分阶段修复**：

- **第一阶段（1 天）**：修复问题 A + 问题 B 方案 1
- **第二阶段（1 天）**：修复问题 C + 添加单元测试
- **第三阶段（2 天）**：添加可观测性 + 问题 B 方案 2/3 + 集成测试

---

## 📚 相关文档

- WebSocket 通信机制：`docs/guide/ws-overview.md`
- Chat 事件规范：`docs/guide/codex-chat-ws-ssot.md`
- 前端架构：`docs/frontend-architecture.md`

---

**分析人员**：Claude
**审核状态**：待审核
**下次更新**：根据修复进展更新
