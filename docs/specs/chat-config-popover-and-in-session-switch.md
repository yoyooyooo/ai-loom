# Chat 配置 Popover 与会话内切换（sendUserTurn）

本文档描述 Codex 聊天在 UI 层的配置入口与“会话内切换”行为。当前实现已启用 `sendUserTurn`，无论新建会话还是已存在会话，都会在每次发送前合并覆盖项并写入 Codex。

## 能力概览

- 配置入口：输入区左侧的齿轮按钮（`CodexChatConfigPanelTrigger`）展示并允许编辑 `model / approvalPolicy / sandboxMode`。
- 覆盖存储：`codex-chat-provider` 将默认配置存放在 `sessions['__default__'].overrides`；已有会话的覆盖保存在对应 `conversationId` 的 `overrides`。
- 发送路径：
  - **无会话**：先调用 `POST /api/chat/conversations`，将默认覆盖带入新会话；首条消息立即通过 `/turns`（sendUserTurn）发送。
  - **已有会话**：始终调用 `/turns`，把当前覆盖和值班工作目录打包为 `sendUserTurn`，实现即时切换。
- 回退策略：若 Provider 返回 `501` 表示不支持会话内切换，前端提示用户新建会话；消息仍可降级通过 `/messages` 发送。

## 交互细节

- Popover 展示：
  - 当前生效模型（取自 `session.capabilities.model`）、默认配置、覆盖值与历史提示；
  - 可在当前会话或“下一次新建”范围内修改覆盖。
- 发送前检测：
  - 若存在已选覆盖，发送按钮旁会显示“本回合使用 xxx”提示；
  - 覆盖值在成功 `sendUserTurn` 后不会被清空，以便持续使用；会话能力（`capabilities.model` 等）会在本地同步更新。
- E2E 行为：
  - 更换模型后直接发送：下一条消息在当前会话中以新模型运行；
  - 切换审批策略或沙箱模式：无需重新建会话即可生效。

## 后端接口

### `GET /api/chat/config`
- Response（示例）：
```json
{
  "cwd": "/abs/path/to/workspace-root",
  "model": "gpt-4.1-mini",
  "profile": null,
  "approvalPolicy": "approved_for_session",
  "sandbox": {
    "mode": null,
    "settings": {
      "writableRoots": ["/abs/path/to/workspace-root"],
      "networkAccess": true
    }
  }
}
```
- 来源：
  - `cwd` ← `AppState.workspace_root`
  - 其余字段 ← Codex RPC `getUserSavedConfig`（参照 `UserSavedConfig.ts` 与 `SandboxSettings.ts`）

### `POST /api/chat/conversations`
- Request（扩展）：`{ model?: string, profile?: string }`
- 行为：
  - 仍传入 `cwd = workspace_root`，其它参数保持默认。
  - 若提供 `model/profile`，透传到 `NewConversationParams`。

### `POST /api/chat/conversations/:conversationId/turns`
- Request：
```json
{
  "text": "用户输入...",
  "model": "gpt-4.1",
  "effort": "medium",
  "approvalPolicy": "never",
  "sandboxMode": "workspace-write"
}
```
- 行为：桥接 Codex `sendUserTurn`，并维持现有 WS 事件映射（`agent_message_delta` → `chat.message.delta`、`task_complete` → `chat.turn.complete` 等）。
- 其他字段：
  - `sandboxWritableRoots?` / `sandboxNetworkAccess?` / `sandboxExcludeTmpdirEnvVar?` / `sandboxExcludeSlashTmp?`：用于细化 workspace-write 策略（可选）。
  - 未提供字段时沿用 Provider 保存的最近一次配置。

## 调试与验证

1. 启动 `just server-dev` 与 `just web-dev`；
2. 在 Popover 中切换模型或审批策略，直接在当前会话发送消息；
3. 观察 WS 流：`chat.info.user_message` 后续应出现新的 `chat.tool.exec.*` / `chat.message.delta` 等事件；
4. 查看 `codex-rs` 日志或 `debug/codex`，可见 `sendUserTurn` 请求记录及更新后的 sandbox 配置；
5. 若需要验证沙箱写权限，选择 `workspace-write` 并在消息中触发 `write` 操作，检查是否落盘到工作区。
