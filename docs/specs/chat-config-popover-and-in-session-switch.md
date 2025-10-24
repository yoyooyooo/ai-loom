# Chat 配置 Popover 与会话内切换（sendUserTurn）规划

本文档规划在聊天输入区附近展示/编辑 Codex 配置（model、profile 等），并支持“会话内切换”在下一次发送时生效（通过 Codex 的 `sendUserTurn`）。分阶段实施，Phase 1 先完成只读展示与“新会话生效”的修改，Phase 2 再支持“会话内切换”。

## 目标
- 在聊天输入区靠近“发送”按钮处，放置配置图标与 Popover：展示当前默认配置（model、cwd、profile、sandbox 摘要）。
- 支持用户编辑 model（优先）与 profile（可选），并在新建会话时生效。
- 规划“会话内切换”：当用户在已有会话中切换配置并发送消息时，使用 `sendUserTurn` 在当前会话内以新配置进行该回合生成。

## 非目标
- 不开放 UI 修改 `cwd`/`sandbox`（安全与一致性考虑）；只读展示。
- 不在 Phase 1 实现 `sendUserTurn`；仅写明 Phase 2 方案。

---

## 阶段拆分

### Phase 1（展示 + 新会话生效）
- 后端
  - 新增 `GET /api/chat/config`：聚合返回 Codex `getUserSavedConfig` 与服务端 `workspace_root`（作为 `cwd` 展示）。
  - 扩展 `POST /api/chat/conversations`：允许可选参数 `{ model?: string, profile?: string }`，透传到 `NewConversationParams`。
- 前端
  - 在输入区按钮行增加“Model 快速选择 + Popover”：
    - 快速选择：直接编辑当前“待应用配置”（存入前端 store），首次发送时若无会话，则带着该配置新建会话。
    - Popover：展示更完整的配置（model/profile/cwd/sandbox），提供“设为默认”的入口（Phase 1 可不做）。
  - Store：新增 `useChatConfigStore`（持久化 `model/profile`），发送前如果没有 `conversationId`，则将其并入 `newConversation` 参数。
  - 已有会话时修改 model：提示“切换将在新会话生效”，并提供“新开会话应用该模型”的快捷操作（清空当前消息状态并新建会话）。

### Phase 2（会话内切换 sendUserTurn）
- 触发原则
  - 当存在 `conversationId` 且用户在输入框附近切换了 model/profile，并点击“发送”，不新开会话，而是对当前会话执行“本回合覆盖”。
- 后端
  - 新增 `POST /api/chat/conversations/:conversationId/turns`（名称待定）：
    - 请求体：`{ items: Array<InputItem>, model?: string, profile?: string, effort?: ReasoningEffort, verbosity?: Verbosity }`
    - 行为：构造 Codex JSON-RPC `sendUserTurn`（参照 `packages/web/src/lib/codex-types/SendUserTurnParams.ts`），透传 `conversationId`、`items`（包含用户文本）与覆盖项；`cwd/approvalPolicy/sandboxPolicy` 与现有一致策略保持（参看 Phase 1）。
  - 兼容性：若 Codex 版本不支持 `sendUserTurn`，后端应返回明确错误码与文案，前端回退提示“请新开会话生效”。
- 前端
  - 发送路径调整：
    - 无会话 → 走 `newConversation({ model/profile })` + 现有 `sendMessage`（保持行为）。
    - 有会话 + 未切换 → 保持现有 `sendMessage`。
    - 有会话 + 已切换 → 走 `sendUserTurn` 路由；本回合在当前会话内生效覆盖（model/profile/effort/verbosity），并复用现有 WS 流事件渲染（无需特殊 UI 分支）。
  - 交互：
    - 发送按钮旁显示“回合覆盖”小徽标/提示（如：`model: gpt-4.1`），仅针对本回合有效；发送后恢复为未覆盖状态。
    - 生成中允许预设“下一回合覆盖”，但不影响正在进行的回合；发送时再生效。

---

## 数据模型与接口（提案）

### `GET /api/chat/config`（Phase 1）
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

### `POST /api/chat/conversations`（Phase 1 扩展）
- Request（扩展）：`{ model?: string, profile?: string }`
- 行为：
  - 仍传入 `cwd = workspace_root`，其它参数保持默认。
  - 若提供 `model/profile`，透传到 `NewConversationParams`。

### `POST /api/chat/conversations/:conversationId/turns`（Phase 2）
- Request（建议）：
```json
{
  "items": [ { "type": "text", "data": { "text": "用户输入..." } } ],
  "model": "gpt-4.1",
  "profile": "coding",
  "effort": "medium",
  "verbosity": null
}
```
- 行为：桥接 Codex `sendUserTurn`，并维持现有 WS 事件映射（`agent_message_delta` → `chat.message.delta`、`task_complete` → `chat.turn.complete` 等）。

---

## 前端架构与交互

### 组件与 Store
- 组件：
  - `features/chat/components/codex-config-popover.tsx`：展示只读信息与可编辑项（model/profile），Hover/Click 打开。
  - 在 `chat-panel.tsx` 按钮行插入“Model 快选 + Popover 入口”。
- Store：
  - `useChatConfigStore`：`{ model?: string; profile?: string }`，持久化到 `localStorage`（键：`chat.config`）。
  - 发送时机：无会话则把 store 值并入 `newConversation`；有会话 + Phase 2 切换则走 `sendUserTurn`。

### 模型候选来源
- `GET /api/chat/config` 提供默认 `model`。
- `GET /api/chat/conversations` 的 `items[*].model` 去重，作为“近期使用”补全；允许用户手输任意模型名（由 Codex 端校验）。

### 生成中与禁用规则
- 生成中不应影响当前回合：
  - 可允许用户切换（作为下一回合 override）；发送时才生效。
  - UI 上可在发送按钮附近以小标签提示“下一回合使用 gpt-4.1”。

---

## 事件与可观测性
- 维持现有 WS 事件桥接（`packages/rust/ailoom-server/src/services/codex/bridge.rs`），Phase 2 仅更换发送入口，不改变事件。
- 调试：
  - 前端 `VITE_WS_DEBUG=1` 观察事件流。
  - 可追加 `VITE_CHAT_CONFIG_DEBUG=1`（可选）在控制台打印覆盖与发送路径选择。

---

## 兼容性与回退
- 若 `sendUserTurn` 不可用：
  - 后端返回特定错误码与友好提示（如 `HTTP_501: sendUserTurn not supported`）。
  - 前端在 Popover/发送前提示“当前版本不支持会话内切换，请新开会话应用”。

---

## 验收与验证（手测）
1. 打开聊天页，Hover 配置图标 → Popover 显示 `cwd/model/profile/sandbox`（model 与 cwd 不为空）。
2. 修改 model，首次发送时无会话 → 新建会话参数包含该 model；WS 流正常。
3. 已有会话中修改 model：弹出“新会话生效”提示；点击“新开会话”后再次发送，确认新会话且模型生效。
4. Phase 2（开发完成后）：已有会话中切换后发送 → 命中 `sendUserTurn` 路径，事件流与现有一致；发送后覆盖状态清空。

---

## 开发任务清单（摘要）
- Phase 1
  - 后端：
    - [ ] `GET /api/chat/config`
    - [ ] `POST /api/chat/conversations` 支持 `{ model, profile }`
  - 前端：
    - [ ] 安装 shadcn/ui Popover 组件
    - [ ] `useChatConfigStore`（persist）
    - [ ] `codex-config-popover.tsx` + `chat-panel.tsx` 快选入口
- Phase 2
  - 后端：
    - [ ] `POST /api/chat/conversations/:conversationId/turns` → Codex `sendUserTurn`
  - 前端：
    - [ ] 发送路径分流（无会话/newConversation，有会话/sendMessage，有会话+覆盖/sendUserTurn）
    - [ ] “本回合覆盖”提示与清理

> 备注：本文档为规划，Phase 1/2 的具体参数字段名在对齐 Codex 版本与本仓路由命名后可微调；实现时请同步更新此文档与 API 注释。

