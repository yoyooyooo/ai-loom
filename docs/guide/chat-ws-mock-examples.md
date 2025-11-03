# Chat WS 事件 Mock 示例

本文示例面向两类测试场景：

- **归一化后的 `chat.*` 事件**：供前端单元测试 / Storybook / 手动构造 store 状态时使用。对应映射逻辑见 `packages/web/src/features/codex-chat/services/ws.ts`。
- **Codex 原始事件（`codex/*`）**：供验证 `bridge.rs` 与前端归一化逻辑时使用。原始事件的完整说明请参阅 `docs/guide/codex-chat-ws-ssot.md`。

通用说明：
- 所有示例均遵循 JSON-RPC 2.0 Notification：`{"jsonrpc":"2.0","method":"<event>","params":{...}}`
- Hub 会在 `params` 中自动注入 `eventId`（字符串）与 `ts`（RFC3339），此处一并给出示例。
- 字段命名与含义以 `docs/guide/codex-chat-ws-ssot.md` 为准。

## 归一化 `chat.*` 事件

<a id="mock-session"></a>
## 会话事件

1) chat.session.new
```
{"jsonrpc":"2.0","method":"chat.session.new","params":{"conversationId":"019a0c27-2133-7202-9354-f434d88cb409","eventId":"1","ts":"2025-10-23T12:00:00Z"}}
```

2) chat.session.resumed
```
{"jsonrpc":"2.0","method":"chat.session.resumed","params":{"conversationId":"019a0c27-2133-7202-9354-f434d88cb409","eventId":"2","ts":"2025-10-23T12:00:01Z"}}
```

<a id="mock-message"></a>
## 答案/失败/中止

3) chat.message.delta
```
{"jsonrpc":"2.0","method":"chat.message.delta","params":{"delta":"等于 ","eventId":"3","ts":"2025-10-23T12:00:02Z"}}
```

4) chat.message.completed（带最终文本）
```
{"jsonrpc":"2.0","method":"chat.message.completed","params":{"text":"等于 4。","eventId":"4","ts":"2025-10-23T12:00:03Z"}}
```

4.1) chat.message.delta（迟到的尾段 → 应比较 `eventId` 后忽略）
```
{"jsonrpc":"2.0","method":"chat.message.delta","params":{"delta":"4。","eventId":"4","ts":"2025-10-23T12:00:03.100Z"}}
```
> 说明：若 `eventId` 未超过上一步 `chat.message.completed` 的事件号，前端需丢弃，以免重复开启新 turn。

5) chat.message.failed
```
{"jsonrpc":"2.0","method":"chat.message.failed","params":{"error":{"message":"sendUserMessage request failed: ..."},"eventId":"5","ts":"2025-10-23T12:00:04Z"}}
```

6) chat.message.aborted
```
{"jsonrpc":"2.0","method":"chat.message.aborted","params":{"eventId":"6","ts":"2025-10-23T12:00:05Z"}}
```

<a id="mock-reasoning"></a>
## 思考通道（合并到本轮助手消息内、默认折叠展示）

7) chat.reasoning.item_started
```
{"jsonrpc":"2.0","method":"chat.reasoning.item_started","params":{"itemId":"itm-1","eventId":"7","ts":"2025-10-23T12:00:06Z"}}
```

8) chat.reasoning.delta
```
{"jsonrpc":"2.0","method":"chat.reasoning.delta","params":{"delta":"先分析…","itemId":"itm-1","eventId":"8","ts":"2025-10-23T12:00:06Z"}}
```

9) chat.reasoning.raw_delta（`show_raw_agent_reasoning=on` 场景）
```
{"jsonrpc":"2.0","method":"chat.reasoning.raw_delta","params":{"delta":"<step>look at repo</step>","itemId":"itm-1","eventId":"9","ts":"2025-10-23T12:00:06Z"}}
```

10) chat.reasoning.item_completed
```
{"jsonrpc":"2.0","method":"chat.reasoning.item_completed","params":{"itemId":"itm-1","text":"总结：…","rawContent":"<full reasoning />","eventId":"10","ts":"2025-10-23T12:00:07Z"}}
```

11) chat.reasoning.end
```
{"jsonrpc":"2.0","method":"chat.reasoning.end","params":{"text":"总结：…","itemId":"itm-1","rawContent":"<full reasoning />","eventId":"11","ts":"2025-10-23T12:00:07Z"}}
```

<a id="mock-exec"></a>
## Exec 工具

12) chat.tool.exec.begin
```
{"jsonrpc":"2.0","method":"chat.tool.exec.begin","params":{"callId":"call_exec_1","cwd":"/Users/yoyo/Documents/code/personal/ai-loom","command":["bash","-lc","ls -la"],"eventId":"12","ts":"2025-10-23T12:00:08Z"}}
```

13) chat.tool.exec.output
```
{"jsonrpc":"2.0","method":"chat.tool.exec.output","params":{"callId":"call_exec_1","stream":"stdout","text":"total 8\n-rw-r--r--  1 …","eventId":"13","ts":"2025-10-23T12:00:08Z"}}
```

14) chat.tool.exec.end
```
{"jsonrpc":"2.0","method":"chat.tool.exec.end","params":{"callId":"call_exec_1","exitCode":0,"durationMs":1200,"stdout":"…（截断）","stderr":"","eventId":"14","ts":"2025-10-23T12:00:09Z"}}
```

<a id="mock-mcp"></a>
## MCP 工具

15) chat.tool.mcp.begin
```
{"jsonrpc":"2.0","method":"chat.tool.mcp.begin","params":{"callId":"call_mcp_1","server":"mcphub","tool":"fetcher-fetch_url","arguments":{"url":"https://example.com","timeout":120000},"eventId":"15","ts":"2025-10-23T12:00:10Z"}}
```

16) chat.tool.mcp.end
```
{"jsonrpc":"2.0","method":"chat.tool.mcp.end","params":{"callId":"call_mcp_1","server":"mcphub","tool":"fetcher-fetch_url","arguments":{"url":"https://example.com"},"result":{"status":200,"content":"…"},"eventId":"16","ts":"2025-10-23T12:00:11Z"}}
```

<a id="mock-patch"></a>
## Patch 工具（默认开启 per-file diff 透出）

14) chat.tool.patch.begin（包含 changes；默认按路径排序、限流：8 文件 / 20000 字符）
```
{"jsonrpc":"2.0","method":"chat.tool.patch.begin","params":{
  "callId":"call_patch_1",
  "files":3,
  "autoApproved":true,
  "firstPath":"/Users/yoyo/Documents/code/personal/ai-loom/src/a.ts",
  "adds":10,
  "dels":4,
  "changes":{
    "/Users/yoyo/Documents/code/personal/ai-loom/src/a.ts":{
      "update":{ "unified_diff":"--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,5 +1,5 @@\n-import { old } from './x'\n+import { newer } from './x'\n export function foo(){\n-  return 1+3\n+  return 2+2\n }\n"}
    },
    "/Users/yoyo/Documents/code/personal/ai-loom/src/b.ts":{
      "add":{ "content":"export const B = 42\n" }
    },
    "/Users/yoyo/Documents/code/personal/ai-loom/src/c.ts":{
      "delete":{ "content":"export const willBeRemoved = true\n" }
    }
  },
  "eventId":"14","ts":"2025-10-23T12:00:12Z"
}}
```

15) chat.tool.patch.end
```
{"jsonrpc":"2.0","method":"chat.tool.patch.end","params":{"callId":"call_patch_1","success":true,"stdout":"Success. Updated the following files:\nM src/a.ts\nA src/b.ts\nD src/c.ts\n","stderr":"","eventId":"15","ts":"2025-10-23T12:00:13Z"}}
```

16) chat.tool.patch.begin（无 changes 版本：当 `AILOOM_CHAT_PATCH_INCLUDE_CHANGES=0` 或后端决定不透出时）
```
{"jsonrpc":"2.0","method":"chat.tool.patch.begin","params":{"callId":"call_patch_2","files":2,"autoApproved":false,"firstPath":"/…/src/d.ts","adds":5,"dels":1,"eventId":"16","ts":"2025-10-23T12:00:14Z"}}
```

17) chat.tool.patch.end（配对 16）
```
{"jsonrpc":"2.0","method":"chat.tool.patch.end","params":{"callId":"call_patch_2","success":false,"stdout":"","stderr":"Patch failed: conflict","eventId":"17","ts":"2025-10-23T12:00:15Z"}}
```

<a id="mock-info"></a>
## 信息与回合结束

18) chat.info.user_message
```
{"jsonrpc":"2.0","method":"chat.info.user_message","params":{"text":"用户消息已发送","kind":null,"eventId":"18","ts":"2025-10-23T12:00:16Z"}}
```

20) chat.info.plan_update
```
{"jsonrpc":"2.0","method":"chat.info.plan_update","params":{"plan":[{"step":"Do A","status":"completed"},{"step":"Do B","status":"pending"}],"explanation":"刷新计划","eventId":"20","ts":"2025-10-23T12:00:18Z"}}
```

21) chat.info.turn_diff
```
{"jsonrpc":"2.0","method":"chat.info.turn_diff","params":{"diff":"--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-foo\n+bar\n","eventId":"21","ts":"2025-10-23T12:00:19Z"}}
```

22) chat.info.approval.exec
```
{"jsonrpc":"2.0","method":"chat.info.approval.exec","params":{"callId":"exec_42","command":["bash","-lc","rm -rf /tmp/x"],"cwd":"/Users/yoyo/ai-loom","reason":"危险操作","eventId":"22","ts":"2025-10-23T12:00:20Z"}}
```

23) chat.info.approval.patch
```
{"jsonrpc":"2.0","method":"chat.info.approval.patch","params":{"callId":"patch_1","reason":"批量变更","grantRoot":"/Users/yoyo/ai-loom","changeCount":3,"eventId":"23","ts":"2025-10-23T12:00:21Z"}}
```

24) chat.info.web_search.begin / end
```
{"jsonrpc":"2.0","method":"chat.info.web_search.begin","params":{"callId":"ws_1","eventId":"24","ts":"2025-10-23T12:00:22Z"}}
{"jsonrpc":"2.0","method":"chat.info.web_search.end","params":{"callId":"ws_1","query":"vite hmr","eventId":"25","ts":"2025-10-23T12:00:23Z"}}
```

26) chat.info.background
```
{"jsonrpc":"2.0","method":"chat.info.background","params":{"message":"已接收消息，但实时订阅建立异常，系统将自动重试。","eventId":"26","ts":"2025-10-23T12:00:24Z"}}
```

27) chat.info.view_image
```
{"jsonrpc":"2.0","method":"chat.info.view_image","params":{"callId":"vi_1","path":"/tmp/screenshot.png","eventId":"27","ts":"2025-10-23T12:00:25Z"}}
```

28) chat.info.conversation_path
```
{"jsonrpc":"2.0","method":"chat.info.conversation_path","params":{"path":"/Users/yoyo/.codex/sessions/.../rollout-0001.jsonl","eventId":"28","ts":"2025-10-23T12:00:26Z"}}
```

29) chat.info.review.entered / review.exited
```
{"jsonrpc":"2.0","method":"chat.info.review.entered","params":{"eventId":"29","ts":"2025-10-23T12:00:27Z"}}
{"jsonrpc":"2.0","method":"chat.info.review.exited","params":{"eventId":"30","ts":"2025-10-23T12:00:28Z"}}
```

19) chat.turn.complete
```
{"jsonrpc":"2.0","method":"chat.turn.complete","params":{"eventId":"19","ts":"2025-10-23T12:00:17Z"}}
```

---

提示：以上仅为通知事件示例。完整事件目录、入环/不入环与字段规范，请参考《Codex Chat WS 事件（SSoT）》的“事件分类索引”和“chat.info.* 事件清单”。真实链路中，请关注后端日志：
- `rpc ⇐ notification method=codex/event/... event_type=<type>`（上游事件）
- `bridge → chat.* mapped chat_method=<...>`（映射结果）

## 端到端序列 A：连续读取 + 思考 + completed（尾插总结）

事件流（时间未必严格单调，这里按逻辑顺序编排）：

```
chat.tool.exec.begin { command:["bash","-lc","ls -la packages/web/src/features/codex-chat"], cwd:"/…/ai-loom" }
chat.tool.exec.end   { callId:"exec_1", exitCode:0 }
chat.tool.exec.begin { command:["bash","-lc","sed -n '1,200p' packages/web/src/features/codex-chat/services/ws.ts"], cwd:"/…/ai-loom" }
chat.tool.exec.end   { callId:"exec_2", exitCode:0 }
chat.reasoning.delta { delta:"先看 chat/ 目录…" }
chat.tool.exec.begin { command:["bash","-lc","rg -n 'plan|todo' packages/web/src/features/codex-chat"], cwd:"/…/ai-loom" }
chat.tool.exec.end   { callId:"exec_3", exitCode:0 }
chat.message.completed { text:"总结：…（最终文案）" }
chat.turn.complete
```

预期渲染（同一张 explored 卡片）

## Codex 原始事件（参考）

以下示例便于联调服务端 `bridge.rs::map_notification_to_chat_events` 与前端 `processChatEvent`。

```
{"jsonrpc":"2.0","method":"codex/sessionConfigured","params":{
  "provider":"codex",
  "sessionId":"019a0c27-2133-7202-9354-f434d88cb409",
  "conversationId":"019a0c27-2133-7202-9354-f434d88cb409",
  "model":"o4-mini",
  "rolloutPath":"/Users/yoyo/.codex/sessions/.../rollout-0001.jsonl",
  "historyEntryCount":24,
  "initialMessages":[{"type":"agent_message","message":"Hi"}],
  "ts":"2025-10-23T12:00:00Z",
  "eventId":"900"
}}

{"jsonrpc":"2.0","method":"codex/event/agent_message_delta","params":{
  "provider":"codex",
  "conversationId":"019a0c27-2133-7202-9354-f434d88cb409",
  "delta":"正在分析…",
  "ts":"2025-10-23T12:00:02Z",
  "eventId":"901"
}}
```

将上述通知送入前端的 WS 调试面板（或单元测试）后，可观察到 `chat.session.history`、`chat.message.delta` 等归一化事件。

```
[explored]  [Exploring…]（在读取类 begin 与 end 之间短暂出现，随后消失）
List chat
Read ws.ts (lines: 1-200)
Search plan|todo in chat

思考（折叠，正文清空，仅保留 reasoning）
总结：…（独立一条，尾部出现）
```

说明：
- 读取类 exec.begin 命中解析 → 只更新 explored（timeline/mergedRanges），不创建 [exec] 卡。
- chat.message.completed → finalize explored → 将过程气泡转为“思考气泡” → 尾插“总结”。
- turn.complete 是兜底屏障，不改变尾插总结的位置。

## 端到端序列 B：停止生成（aborted）

```
chat.tool.exec.begin { command:["bash","-lc","rg --files packages/web/src/features/codex-chat"], cwd:"/…/ai-loom" }
chat.message.aborted
chat.turn.complete
```

预期渲染：

```
[explored]
List chat

已停止生成（过程气泡清空正文，status=aborted）
```

说明：
- aborted 会 finalize explored，并把占位正文清空（若仍为占位），方便用户做下一步操作。

## 端到端序列 C：读取类与非读取工具穿插

```
chat.tool.exec.begin { command:["bash","-lc","sed -n '1,200p' a.ts"], cwd:"/…/ai-loom" }
chat.tool.exec.end   { callId:"exec_r1", exitCode:0 }
chat.tool.exec.begin { command:["bash","-lc","echo hello && date"], cwd:"/…/ai-loom" }  // 未命中读取 → 非读取工具
chat.tool.exec.output{ callId:"exec_nonread", text:"hello" }
chat.tool.exec.end   { callId:"exec_nonread", exitCode:0 }
chat.tool.exec.begin { command:["bash","-lc","sed -n '200,400p' a.ts"], cwd:"/…/ai-loom" }
chat.tool.exec.end   { callId:"exec_r2", exitCode:0 }
```

预期渲染：

```
[explored]
Read a.ts (lines: 1-400)   // 第二段读取原位合并，不新增行

[exec] echo hello && date  // 非读取工具卡（原位 begin → end）
stdout: hello
```

说明：
- 非读取 exec.begin 被视为“分段信号”，会 finalize explored；如果下一次读取发生在之后，将新开一张 explored 卡。
- 读取类 exec 只更新 explored，不生成 [exec] 卡。
