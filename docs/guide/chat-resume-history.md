# Chat 历史与会话恢复（Codex-only）

## 路由概览
- `/chat`：聊天主界面，左侧历史列表 + 右侧聊天区。
- `/explore`：沿用原首页三栏（活动栏 / 目录树 / 编辑器）。

## 历史列表
- 默认每页 20 条，可点击底部“加载更多”分页。
- 列表条目展示 `preview`、`timestamp`、`model`（如有）。
- 当前选中条目会高亮。

## 恢复流程
1. 点击历史项 → 若当前会话正在生成，提示用户是否中止并调用 `/api/chat/conversations/interrupt`。
2. 成功后调用 `POST /api/chat/conversations/resume`：
   - 后端依据 `resumeConversation` 成功返回 `conversationId` 并追加一条 `chat.session.resumed`。
   - 如果 Codex 未返回完整历史，服务器会解析 rollout JSONL（`session_meta` / `turn_context` / `environment_context`），补齐 `history` 与配置快照。
   - 返回 payload：
     ```jsonc
     {
       "conversationId": "019a...",
       "history": [ {"role":"user","text":"..."}, ... ],
       "config": {
         "model": "o4-mini",
         "approvalPolicy": "on-request",
         "sandbox": { "mode": "workspace-write", "networkAccess": true, ... },
         "overrides": { "model": "o4-mini", "config": {"sandbox_workspace_write.network_access": true} },
         "cwd": "<last cwd>",
         "environment": { ... 原始 environment_context ... }
       }
     }
     ```
3. 前端处理：
   - `chatPage` 在收到响应后调用 `codexChatActions.reset()` 并回放 `history`。
   - `codexChatProviderActions.resetSession` 清除旧覆盖值，再写入 `setOverrides` 与 `setCapabilities`（详见 `deriveResumeOverrides`、`deriveResumeCapabilities`）。
   - 更新路由并在输入框下方展示提示 banner。
4. 恢复失败时弹出错误提示并保持原会话可操作。

## WebSocket 隔离
- 所有 `chat.*` 事件都包含 `conversationId`。
- 前端仅处理与当前 `conversationId` 匹配的事件。
- 通过 `subscribe('chat', { conversationId })` 订阅会话级事件，为未来多会话 UI 打底。

## 配置恢复（SSoT 摘要）

- Rollout 解析：`packages/rust/ailoom-server/src/routes/chat/resume/*`
  - 读取 `session_meta`、`turn_context`、`environment_context`，组合出 `ResumeConfigResponse`。
  - 对 workspace-write 沙箱附带 `sandbox_workspace_write.*` 键值，写入 `overrides.config`。
- API：`/api/chat/config` 提供模型列表与默认配置；恢复时的覆盖值通过 `config.overrides` 注入。
- Store：`packages/web/src/stores/codex-chat-provider.ts` 为单点事实来源，`overrides` 与 `capabilities` 均按 `conversationId` 分桶。详见 `docs/guide/codex-chat-config.md`。
- UI：`packages/web/src/features/codex-chat/components/chat-config-panel.tsx` 在输入框右侧展示当前模型、审批策略、沙箱、额度与 session metadata。

## API 提要
- `GET /api/chat/conversations?pageSize&cursor`：返回历史列表。
- `POST /api/chat/conversations/resume { path? }`：恢复指定/最新会话。
