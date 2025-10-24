# Chat 故障排查与调试

本文列出“对话卡住/无事件/状态不复位”等常见问题的排查路径与工具。

## 快速自检清单

- 会话创建
  - 浏览器 Network：`POST /api/chat/conversations` 是否 200/201 并返回 `conversationId`
  - 失败时前端会提示“创建会话失败”，按钮复位

- 后端是否收到 Codex 推流
  - 启动：`just dev-all-debug`
  - 关注日志：
    - `rpc ⇐ notification method=codex/event/... event_type=<msg.type>`
    - 常见类型：`agent_message_delta`、`agent_message`、`task_complete`、`exec_command_*`、`mcp_tool_call_*`

- chat.* 是否广播到前端
  - 同时关注：`bridge → chat.* mapped chat_method=<...>`
  - 前端控制台开 `VITE_WS_DEBUG=1`，应可见 `[ws] event chat.*`

## 典型问题场景

- 只有心跳、无 chat.*
  - 多因 Codex App Server 未就绪或没有 addConversationListener
  - 处理：重启后端；或看 `rpc → addConversationListener` 是否成功

- 按钮停在“停止生成”
  - 正常收束信号：`chat.message.completed` 或 `chat.turn.complete`
  - 若无 `completed`，可使用 `turn.complete` 作为收尾信号；检查后端是否正确映射 `task_complete → chat.turn.complete`。

- 停止后正文仍显示“正在分析…”
  - 现已修正：abort 时若仍为占位，正文清空，仅显示状态条“已停止生成”

- Patch 卡片仅显示“X files”，没有路径/行数
  - 需升级后端：`patch_apply_begin` 现在会注入 `firstPath/adds/dels`，封面会显示 `<firstPath> +adds -dels (+N)`

## 相关文件

- WS 事件与约定：`docs/guide/codex-chat-ws-ssot.md`
- WS 客户端：`packages/web/src/lib/ws/rx-client.ts`
- 订阅与分发：`packages/web/src/features/codex-chat/services/ws.ts`
- Store（Zustand）：`packages/web/src/features/codex-chat/stores/chat.ts`
- 请求封装（axios + RxJS）：`packages/web/src/features/codex-chat/services/api.ts`、`packages/web/src/lib/request.ts`
- 后端桥接：`packages/rust/ailoom-server/src/services/codex/bridge.rs`
- Codex 客户端与日志：`packages/rust/ailoom-server/src/services/codex/client.rs`
- REST 路由：`packages/rust/ailoom-server/src/routes/chat/{new.rs,send.rs,interrupt.rs,resume/*}`

## 常用命令

- 一键联动（调试日志开启）：`just dev-all-debug`
- 仅后端热重载：`just server-dev PORT=63000`
- 仅前端 Dev：`just web-dev VITE_API_BASE=http://127.0.0.1:63000`
