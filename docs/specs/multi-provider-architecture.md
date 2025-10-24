# 多 Provider 规划与架构（长期演进）

> 本文是未来演进的规划文档，不属于当前迭代的交付范围。当前阶段我们专注于 Codex‑only，并在其上做到极致。待各 Provider 的独立 GUI 模块成熟后，再推进汇总版与原地切换 Provider。

## 目标与范围

- 目标
  - 在“汇总版”中提供通用聊天模块，支持在同一会话内原地切换 Provider（Codex、Claude Code、Gemini CLI 等）。
  - 在保持良好用户体验的同时，最大化复用各 Provider 的最佳实践与特性。

- 当前范围（不纳入本阶段）：
  - Provider 抽象、统一域事件/数据层、原地切换机制、平台工具层。
  - 仅做架构预研与规格沉淀，待时机成熟再实施。

## 路线图（阶段性）

1) 多 Provider 独立 GUI 模块（与 Codex 同级）
- 为 Claude Code、Gemini CLI 等命令行 Agent 工具，各自实现“界面化”模块，可独立使用。
- 与 Codex 模块保持一致的交互风格与调试工具，但不强行抽象统一层（降低耦合、快速迭代）。

2) 汇总版（Aggregator）
- 在多个独立模块相对成熟后，推出“汇总版”：
  - 提供统一入口与通用聊天模块。
  - 支持“原地切换 Provider”。
  - 引入统一域事件/数据、Provider 抽象与平台工具层。

## 架构设计（汇总版）

### Provider 抽象

- 统一接口
  - `ChatProvider`：`new/resume/attach/send/interrupt/addListener/list`
  - `ModelProvider`：`listModels/getDefaultModel/getRateLimits`
  - `AuthProvider`：`login/logout/status`
- 路由与注册表
  - `ProviderRegistry` 根据 `providerId` 分发请求。
  - Codex 作为 `CodexProvider`（JSON‑RPC + `codex-app-server-protocol`）；其他 Provider 基于 HTTP/流式。

### 域事件与类型（Provider 中立）

- **事件分层**：沿用 Codex 改造经验，以“原始 Provider 事件 + 平台归一化事件”双层结构推进：
  - 原始事件命名为 `<providerId>/*`（如 `codex/event/*`、`claude/event/*`），payload 完整反映 Provider 协议，并附上 `provider`、`conversationId`。
  - 平台事件统一为 `chat.*` 命名，在 `params` 中同时带 `providerId`、`conversationId`、`raw`（可选）等字段，保证 UI/状态机的统一语义。
- **域事件清单**（`chat.*`）：`chat.sessionConfigured`、`chat.user_message`、`chat.assistant_message`、`chat.turn.started/complete/aborted`、`chat.tool.exec.*`、`chat.tool.patch.*`、`chat.info.*`、`chat.rate_limits.updated`、`chat.provider.changed`、`chat.error` 等。
- **类型导出**：
  - 平台域模型由服务器导出 TS/Schema，供任何 Provider 共享。
  - Provider 专属类型（如 Codex 的 `EventMsg`）仍由官方 crate 输出，仅在适配层/调试层使用。

### 会话与切换（原地切换）

- 绑定与分段
  - 维护 `provider_bindings`（`conversationId` → `{ providerId, externalId, model, capabilities, since }`）
  - 切换时创建新分段（segment），保留旧绑定以便回看/回切。
- 上下文重建
  - 用“滚动摘要 + 最近窗口 + 关键锚点（patch/exec/重要回复）”重建新 Provider 的提示输入。
  - Codex ↔ 其他 Provider 的相互映射通过“域消息格式”实现。
- 原子切换流程
  - 校验无在途 turn → `detach` 当前 → `attach` 新 Provider（创建/恢复外部会话）→ 广播 `providerChanged` + `sessionConfigured`。

### 工具与动作（patch/exec 等）

- 平台工具层
  - 将 `apply_patch`、`exec_command`、`fuzzy_file_search` 等抽象为平台工具。
  - CodexProvider 透传原生工具；其他 Provider 通过函数调用（tool call）触发平台实现或禁用。
- 能力矩阵
  - `capabilities` 描述 Provider 支持的工具/事件/鉴权模式；前后端按能力动态启用功能。

### 数据与持久化

- 最小通用存储
  - 会话主表：`conversationId`、标题、预览、时间戳。
  - 绑定表：`provider_bindings`；分段表：`conversation_segments`（摘要、窗口游标、模型、能力快照）。
  - 非 Codex Provider 的轻量消息日志可存本地 DB；Codex rollout 仍由 Codex 管理（仅索引路径）。
- 摘要策略
  - 维护“滚动摘要”与“关键引用索引”，用于切换时快速注入上下文。

### 前端改动

- Provider 选择器：会话头部可切换；切换默认建立新分段并重建上下文。
- Query Keys：纳入 `providerId` 与 `conversationId`（如 `['chat', provider, conversationId]`、`['models', provider]`）。
- 事件订阅：统一消费 `chat.*`；若需调试，可读取 `params.providerId` 或 `params.raw`，并利用 `/debug/<providerId>`。
- 工具可见性：按 `capabilities` 动态展示/禁用 patch/exec；非 Codex 提供“模拟 apply_patch”的提示或受限能力。
- Provider Store：延续 Codex 的做法，按 `providerId + conversationId` 分桶，维护 `capabilities`、`models`、`overrides` 等。

### 安全与策略

- 审批/沙箱：平台统一 `approvalPolicy`/`sandboxMode` 语义；对非 Codex Provider 默认限制写盘/exec（白名单可选）。
- 凭据与限流：按 `providerId` 管理 API Key、baseURL、模型清单与 Rate Limits。

## 风险与边界

- 能力差异大：需要能力矩阵与 UI 策略避免“同一 UI 做不到同样事”。
- 上下文损耗：切换质量依赖摘要/锚点；需在域模型长期沉淀“重要打点”。
- 原子性与回滚：切换失败时回滚到前一绑定，避免会话不可用。

## 验收（汇总版阶段）

- 同一 `conversationId` 内成功从 Codex 切换到其他 Provider 并继续对话，消息上下文连贯。
- patch/exec 在 Codex 生效；在其他 Provider 受限或走平台工具实现；UI 按能力动态调整。
- 事件：前端仅消费 `chat/*` 域事件，调试可查看 `raw`；日志含 `providerId` 维度。

## 备注

- 当前阶段不实施以上改造；本文作为未来演进的设计锚点，实际细节会根据届时的产品目标与技术条件进行调整。
