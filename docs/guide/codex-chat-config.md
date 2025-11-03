# Codex Chat 配置与能力（SSoT）

本节描述 Codex 聊天在“模型/审批/沙箱”维度的事实来源、API 契约与前端状态流转。该信息覆盖“新建会话”“恢复会话”“会话中动态更新”三个场景。

## 后端 API

### `/api/chat/config`

- 位置：`packages/rust/ailoom-server/src/routes/chat/config.rs`
- 行为：
  1. 通过 `codex-app-server-protocol` 调用 `listModels`，返回可选模型清单：
     ```jsonc
     {
       "models": [
         {
           "id": "o4-mini",
           "model": "o4-mini",
           "displayName": "OpenAI o4-mini",
           "description": "最新推理模型",
           "isDefault": true,
           "defaultReasoningEffort": "medium",
           "supportedReasoningEfforts": ["low","medium","high"]
         }
       ]
     }
     ```
  2. 调用 `getUserSavedConfig`，整理默认的 `model`、`approvalPolicy`、`sandboxMode`。
- 错误处理：当 Codex 未就绪时返回 `502`，并附加 `codex_not_reachable_hint()`。
- 用途：页面加载完成后首次调用，联动 `codex-chat-provider` 填充默认能力。

### `/api/chat/conversations/resume`

- 位置：`packages/rust/ailoom-server/src/routes/chat/resume/*`
- 功能：
  1. 解析 rollout JSONL（`session_meta`、`turn_context`、`environment_context`），恢复最近一次生效的配置。关键结构详见 `RolloutConfigSnapshot`。
  2. 调用 `resumeConversation`（Codex 官方 API），并把返回的 `initial_messages` 映射成 `history`。
  3. 返回 `config`：
     - `model` / `approvalPolicy` / `sandbox` 当前值。
     - `cwd`、`effort`、`summary` 等补充信息。
     - `overrides`：传回给前端的原始覆盖键值（例如 `sandbox_workspace_write.network_access=true`）。

### `/api/chat/conversations/:conversationId/turns`

- 位置：`packages/rust/ailoom-server/src/routes/chat/turn.rs`
- 行为：
  1. 接收 `{ text, model?, approvalPolicy?, sandboxMode?, sandboxNetworkAccess?, sandboxWritableRoots?, effort?, summary? }`（均为可选值，`text` 必填）。
  2. 合并工作区根目录（`cwd`）与覆盖项，构造 Codex JSON-RPC `sendUserTurn`，从而在当前会话内即时切换模型/审批/沙箱等配置。
  3. 覆盖项缺失时沿用最近一次成功发送时保存的会话配置；若 Provider 未实现 `send_user_turn`，返回 `501 Not Implemented` 并提醒前端回退至新建会话。
- 额外广播：与 `/messages` 一致，在 HTTP 接收阶段即入环 `chat.info.user_message`，确保 UI 及时回显用户输入。
- 用途：支持“已存在的会话”按回合切换配置；新建会话后的首条消息也会走该接口，确保配置立即生效。

## 前端状态：Provider Store

- 现状：`packages/web/src/stores/codex-chat-provider.ts`
- 结构：以 `conversationId` 分桶（缺省桶 `__default__` 用于“下一次新建会话”）。未来可推广到多 Provider，例如以 `sessions[providerId][conversationId]` 的方式维护。 
- 关键 action：
  - `setSessionCapabilities`：合并 `codex/sessionConfigured` 与运行时事件（rate limit、token count）。
  - `setSessionModels`：更新 `models` 清单（来源 `/api/chat/config`）。
  - `setSessionOverrides`：写入会话级覆盖（新建会话或恢复会话时使用）。
- 能力字段：
  - `features`：当前 CLI 支持的工具能力（patch / exec / modelsList / rateLimits / auth / images / toolCalls）。
  - `defaults`：来自 `/api/chat/config` 的默认值。
  - `model`：当前会话实际绑定的模型（由 `codex/sessionConfigured` 提供）。
  - `rateLimits`：剩余额度与重置时间，来自 `codex/account/rateLimits/updated`。
  - `extra.sessionConfigured`、`extra.rateLimitsSnapshot`、`extra.tokenCount` 等调试字段。

## 事件驱动

| 事件 | Store 更新 | 备注 |
| --- | --- | --- |
| `/api/chat/config` | `setSessionModels('__default__', models)` + `setSessionCapabilities('__default__', { defaults: ... })` | 页面加载时调用一次。 |
| `codex/sessionConfigured` | 更新当前会话 `capabilities.model`、`capabilities.extra.sessionConfigured`，并透传 `initialMessages` → `chat.session.history`。 |
| `codex/account/rateLimits/updated` | 写入 `capabilities.rateLimits` 与 `extra.rateLimitsSnapshot`。 |
| `codex/event/token_count` | 写入 `capabilities.extra.tokenCount`。 |
| Resume API (`config.overrides`) | `setOverrides('__default__', overrides)` + `setOverrides(conversationId, overrides)`；同时基于 `config` 重刷 `capabilities`。 |

## UI 与交互

- 配置面板：`packages/web/src/features/codex-chat/components/chat-config-panel.tsx`
  - 通过 `CodexChatConfigPanelTrigger` 按钮访问，展示“当前模型 / 默认值 / 覆盖 / 额度 / 会话元数据”，并允许编辑 `model / approvalPolicy / sandboxMode`。
  - 模型列表通过 `models` 渲染；支持标记默认模型。选择结果会写入 Provider Store 的 `overrides`，作为后续 `newConversation` 与每次 `sendUserTurn` 的覆盖来源。
- 恢复提示：`chat-page.tsx` 会在成功恢复后弹出 “已恢复到历史会话” banner，并同步刷新历史列表。
- 输入框覆写：当会话存在时，后续发送改走 `/turns`，每一轮都会把最新的覆盖值写入 Codex；无会话时仍通过 `/conversations` 先创建再发送首轮 `sendUserTurn`。

## 开发校验

- 单元测试：`packages/web/src/features/codex-chat/stores/chat/chat.store.test.ts` 检查回放与 explored 聚合；可配合 `pnpm --dir packages/web test` 使用。
- 端到端验证建议：
  - 启动 `just server-dev` + `just web-dev`；
  - 开启 `VITE_WS_DEBUG=1 VITE_WS_DEBUG_ROUTE=1` 观察 `codex/*` → `chat.*`
  - 使用 `/api/chat/config` 与 `/api/chat/conversations/resume` 搭配 Postman/Rest Client 验证返回字段。

更多细节请参考：
- `docs/guide/codex-chat-ws-ssot.md`（事件流与映射）。
- `docs/guide/chat-resume-history.md`（历史面板与恢复流程）。
- `/debug/codex`（事件与统计 JSON，便于核对 `codex/*` 与 `chat.*`）。
