# Codex 协议与类型接入方案（无向后兼容，Codex‑only）

> 目标：对齐 openai/codex 官方协议与类型，直接面向未来版本演进，不保留向后兼容路径；在不牺牲现有能力的前提下，简化桥接、统一类型源，并为 MCP 与后续接口升级留出空间。

## 当前状态（2025-10-25）

- **单一事实源（SSoT）** 已迁入 `docs/guide`：
  - 事件流：`docs/guide/codex-chat-ws-ssot.md`
  - 会话配置 / 覆盖：`docs/guide/codex-chat-config.md`
  - 历史恢复：`docs/guide/chat-resume-history.md`
  - 版本固定：`docs/guide/codex-versioning.md`
- **核心落地**：
  - Rust 端已引入官方 crate（`codex-protocol`、`codex-app-server-protocol`），`transport.rs`/`client.rs`/`bridge.rs` 均基于官方类型实现。
  - App Server 通过 `CODEX_VERSION` 固定到 `@openai/codex@0.50.0`，`scripts/check-codex-version.sh` 用于校验版本一致性。
  - 后端向浏览器广播 `codex/*` 事件，并由前端统一归一化为 `chat.*`。
  - 前端 store 完成 slice 化：`features/codex-chat/stores/chat/` 负责消息流，`stores/codex-chat-provider.ts` 管理能力/覆盖。
  - 恢复流程支持从 rollout JSONL 恢复配置（模型 / 审批 / 沙箱 / cwd 等）。

## 待办与后续规划

以下项目尚未落地或仍在规划中：

1. **调试与观测扩展**：`/debug/codex` 已提供基础事件/统计输出，但仍缺少 `codex.rpc` tracing 聚合与背压指标调优。
2. **多 Provider 抽象**：`ChatService`/`CodexBackend` trait 尚未产出，当前代码仍以 Codex-only 实现为主。
3. **功能补完**：面板内切换模型/审批/沙箱仍为只读；未来需要基于 `newConversation.config` 与 `sendUserTurn` 落地写入逻辑。

以下章节保留原方案设计与上下文说明，供后续迭代参考；若与 SSoT 不一致，以 SSoT 为准。

## 背景

- 现状
  - 后端通过子进程方式运行 Codex App Server：`npx @openai/codex@0.46.0 app-server`（见 `packages/rust/ailoom-server/src/services/codex/app_server.rs`）。
  - 传输层：自研 JSON‑RPC 管道（`jsonrpc.rs`），包含 `jsonrpc: "2.0"` 字段；官方 `jsonrpc_lite` 不要求该字段。
  - 类型层：在本仓库内手写了一批请求/响应与事件字段，桥接为前端 WS 事件（SSoT），核心位于 `packages/rust/ailoom-server/src/services/codex/bridge.rs`。
  - 前端：遵循 WS‑first；UI 与缓存以 `chat_events` 为唯一事实来源（SSoT）。
- 痛点
  - 类型重复维护、魔法字符串较多，协议演进时易“手抄错漏”。
  - 官方新增接口（如 `account/*`、`model/list`）与废弃接口并存；缺少运行时能力协商与渐进兼容。
  - 未来可能直连 MCP（`codex mcp-server`），当前传输层抽象不足。

## 设计目标与原则

- 强类型：最大化复用官方 Rust crate（协议/类型），减少魔法字符串与手抄类型。
- 简化：统一采用官方 JSON‑RPC 形态（`jsonrpc_lite`），不再发送 `jsonrpc: "2.0"` 字段，也不支持旧形态消息。
- 面向未来：不做向后兼容与降级逻辑；以固定上游版本为准（必要时整体升级）。
- 可插拔：预留 MCP 直连后端；传输/后端实现可替换（App Server JSON‑RPC、MCP）。
- 自动化：前端类型由后端生成（TS/JSON Schema），避免手抄。
- 可观测：统一 tracing 维度，便于排障与压测。

## 现阶段范围与边界（Codex 优先、原汁原味）

- 单一 Provider：当前仅聚焦 Codex，全力把 Codex 集成做到极致，作为“Codex 的界面化应用”。
- 存储来源：会话读取/写入均以 Codex 自身的本地化存储（rollout JSONL 等）为准；后端仅做桥接与最小增强，不另起平台侧持久化（除必要的索引/缓存）。
- 事件命名：WS 事件统一采用 `codex/*` 命名，直接映射官方 `ServerNotification`，仅补充必要上下文（如 conversationId）。
  - 注意：请同步校验“前后端事件映射”是否完整（后端 `bridge.rs` → 前端订阅与消费位置，如 `packages/web/src/lib/ws/*` 与实际组件）。任何事件名/字段调整需联动更新，否则功能将中断。
- JSON‑RPC：采用官方 `jsonrpc_lite` 形态（不含 `jsonrpc` 字段）；不支持旧形态。
- 版本约束：对齐 `rust-v0.50.0`，App Server 固定 `@openai/codex@0.50.0`；升级采取整体前移策略。

说明：这一阶段的目标是把 Codex 体验“原汁原味”地呈现出来，使本项目可以单独作为 Codex 的 GUI 使用。



## 范围与需求

### 必须（Must‑have）
- [x] 依赖官方 crate 并固定版本（`rust-v0.50.0`，Rust 1.90+）。
- [x] 全量采用官方类型与 `jsonrpc_lite` 形态（`jsonrpc.rs` 已移除）。
- [x] 事件命名与 payload 与官方保持一致（`codex/*`），详见 `docs/guide/codex-chat-ws-ssot.md`。

### 应该（Should‑have）
- [x] 前端类型自动生成脚本（`just codex-codegen` 调用 `codegen-codex-types`，输出 TS + JSON）。
- [x] 调试与观测基础：`/debug/codex` 调试端点、WS hub 统计、`codex` 事件筛选。

### 可选（Nice‑to‑have）
- `CodexBackend` 抽象与多后端
  - 定义 `trait CodexBackend { fn request(..); fn subscribe(..); }`，实现 `AppServerJsonRpcBackend`（默认）与 `McpServerBackend`（预留）。
- 事件原样通道
  - 增加 `experimental_raw_events`，并行广播“typed 事件”和“原始 notification”，便于排障。

## 本次实施的低代价准备（为未来多 Provider 预埋）

在不改变 Codex-only 功能路径的前提下，进行如下低代价优化，作为当前迭代内容：

- 后端（服务与事件）
  - 门面与命名：新增 `services/chat/mod.rs`（门面），对外暴露中性接口（如 `ChatService`），内部复用既有 Codex 实现（不搬文件，先 re-export）。
  - 轻量接口：定义面向当前使用面的最小 trait（`initialize/new/resume/add_listener/send/interrupt/list`），由 Codex 适配器实现，调用点依赖 trait。
  - 事件附加字段：WS 事件 payload 附加只读 `provider: "codex"` 字段（前端可忽略）。
  - 日志统一维度：所有 codex 相关 tracing 增加 `provider="codex"` 字段，targets 继续用 `codex.rpc/codex.event/codex.bridge`。
  - 事件覆盖检查：在 `bridge.rs` 增加事件覆盖日志或测试，启动时统计未映射的 Codex 通知类型并提示。

- 前端（Store 与订阅）
  - Query Key 预留：在新代码中采用 `['chat', 'codex', conversationId]`、`['models', 'codex']` 形态；存量不强改，逐步演进。
  - 能力占位：在 chat store 中加入只读 `capabilities`（当前硬编码为 Codex 支持 patch/exec 等），组件按能力渲染而非写死常量。
  - 目录与依赖：Codex 聊天界面放置于 `features/codex-chat/*`，容器组件只依赖门面 API，避免直接耦合 Codex 客户端细节。
  - 事件入口预留：在 ws 接入层预留“域事件入口”函数签名，当前实现直接透传 `codex/*`。

- 工程化与运维
  - 版本一致性：落地 `just codex-pin <version>` 与 `just codex-verify`（参见“版本对齐自动化与校验”），CI 启用 verify 守卫。
  - 调试端点：实现 `/debug/codex` 导出最近 N 条事件流水与统计。
  - 背压开关：WS 广播通道预置有界队列与丢弃策略开关（默认关闭）。
  - 测试骨架：补充后端最小集成测试（new → addListener → send → interrupt 的 happy path），必要时 `#[ignore]`，作为将来多 Provider 的对齐基线。

- 文档与规范
  - 契约与入口：在本规格与前端 README 中明确“后端门面接口”“前端事件入口”与“Query Key 约定”。
  - 命名边界：对外暴露使用中性命名（chat/conversation）；Codex 细节限定在 `services/codex/*` 命名空间。

## Capabilities 与“输入框侧边配置面板”

为避免过度设计，Capabilities 采用“最小通用集 + Codex 扩展”模式：

- 数据来源（Codex App Server 协议）
  - 模型与默认：`model/list`（ListModels）、`getUserSavedConfig`、`setDefaultModel`
  - 会话/回合覆盖：`newConversation` 的 `model/approval_policy/sandbox/config(overrides)`；`sendUserTurn` 的 `approval_policy/sandbox_policy/model/effort/summary`（后续切换到 sendUserTurn 再启用回合级更新）
  - 账号与额度：`account/login` / `account/logout` / `account/read` / `account/rateLimits/read` / `authStatus`
  - 工具与沙箱设置：`[tools]`、`sandbox_mode`、`[sandbox_workspace_write]` 来自 `config.toml`（通过 `getUserSavedConfig` 读取；通过 `newConversation.config` 临时覆盖）
  - MCP：`[mcp_servers.*]`（目前主要经 CLI/配置文件管理；UI 管理可择机接入，或通过 `execOneOffCommand` 调用 `codex mcp list --json` 做只读展示）

- Capabilities 最小接口（前端 store：`stores/chat.ts`）

```ts
export type ProviderId = 'codex' | string

export type ChatCapabilities = {
  providerId: ProviderId
  version?: string
  // 可用功能位（组件显隐/禁用依据）
  features: {
    patch: boolean
    exec: boolean
    modelsList: boolean
    rateLimits: boolean
    auth: boolean
    images?: boolean
    toolCalls?: boolean
  }
  // 默认运行策略（展示用；调整由配置/覆盖生效）
  defaults?: {
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
    sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  }
  // 当前会话/账号态观测值
  model?: string
  authenticated?: boolean
  rateLimits?: { remaining?: number; resetAt?: string }
  // Codex 扩展（以 extra 承载，避免污染通用层）
  extra?: Record<string, unknown>
}
```

- 侧边配置面板（输入框旁）分组与映射
  - Model（必选）
    - 数据：`model/list` → 可选项；当前选中：Capabilities.model
    - 写入：优先“本会话覆盖”（`newConversation.model`）；“设为默认”→ `setDefaultModel`
    - 高级：`model_reasoning_effort`、`model_reasoning_summary`、`model_verbosity`（作为高级区；本会话覆盖经 `newConversation.config`，或后续 `sendUserTurn`）
  - Approvals（审批策略）
    - 数据：`getUserSavedConfig.defaults.approval_policy`
    - 写入：本会话覆盖 `newConversation.approval_policy`（后续回合级 `sendUserTurn.approval_policy`）
  - Sandbox（沙箱）
    - 数据：`getUserSavedConfig.sandbox_mode` + `[sandbox_workspace_write]`
    - 写入：本会话覆盖 `newConversation.sandbox`；高级项（`network_access/exclude_*`、`writable_roots`）通过 `newConversation.config` 传 TOML 键（如 `sandbox_workspace_write.network_access=true`）
  - Tools（工具）
    - 数据：`getUserSavedConfig.tools`（`web_search`、`view_image`）
    - 写入：本会话覆盖 `newConversation.config`（`tools.web_search=true` 等）
  - MCP（精简）
    - 只读展示已配置服务器（优先使用 CLI：`codex mcp list --json` 通过 `execOneOffCommand` 拉取；或在首次版本不做管理，仅放“打开文档/打开配置”跳转）
    - 高级项：`startup_timeout_sec`、`tool_timeout_sec`、`enabled_tools/disabled_tools`（后续管理）

- Store 分层
  - `stores/codex-chat.ts`：保留 Codex 专属状态与业务（不大动存量）
  - `stores/chat.ts`：新增通用层，仅承载 `{ providerId, capabilities }` 与最小 action（`setCapabilities`）
  - 事件更新：
    - `codex/sessionConfigured` → `capabilities.model`
    - `codex/account/rateLimits/updated` → `capabilities.rateLimits`
    - `codex/authStatusChange` → `capabilities.authenticated`
  - 后端提供 `/api/chat/config` 读取模型列表与 `getUserSavedConfig` 默认值，前端初始化时一次性拉取，并写入通用 store（`models` / `capabilities.defaults` / `overrides`）。

- 交互原则
  - “本会话覆盖优先；持久化谨慎”：面板默认只影响“新建/恢复会话”的参数；对“设为默认”的持久化动作单独二次确认（例如仅对 model 使用 `setDefaultModel`）。
  - “即时更改（可选）”：待迁移到 `sendUserTurn` 后，允许在进行中对话改变 `approval/sandbox/model/effort/summary`（当前先不启用）。

> MCP 配置完整管理涉及 CLI 子命令与 `config.toml` 变更，初期建议只读展示 + 跳转文档；后续再接入管理（或通过 `execOneOffCommand` 封装 `codex mcp add/remove`）。

## 技术方案

### 依赖与版本固定（示例）

```toml
[dependencies]
# 以官方仓库为源；package 名称对应子工作区 crate 名；固定 rev 以确保可重复构建
codex-protocol = { git = "https://github.com/openai/codex.git", package = "codex-protocol", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
codex-app-server-protocol = { git = "https://github.com/openai/codex.git", package = "codex-app-server-protocol", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
# 如需：
# mcp-types = { git = "https://github.com/openai/codex.git", package = "mcp-types", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
```

说明：Cargo 能在 git 仓库中查找工作区成员，无需额外 subdir 配置，仅通过 `package = "..."` 即可定位 crate。

#### 版本对齐自动化与校验（建议）

目标：保证 `npx @openai/codex@<npm_version> app-server` 与 Cargo 中 `codex-*-protocol` 的 `rev` 指向同一上游版本（同一 rust tag 的 commit），并在 CI 中自动校验。

- 统一版本源：定义单一版本变量，例如 `CODEx_VERSION=0.50.0`（npm 版本），其对应的 Rust tag 为 `rust-v$CODEx_VERSION`。
- 获取 tag 对应 commit：
  - `sha=$(curl -s https://api.github.com/repos/openai/codex/tags | jq -r ".[] | select(.name==\"rust-v$CODEx_VERSION\") | .commit.sha" | head -n1)`
- 写入 Cargo.toml：
  - 用 `sed -i.bak` 或 `sd` 将 `rev = "..."` 更新为 `$sha`（两处：`codex-protocol` 与 `codex-app-server-protocol`）。
- 写入 App Server 版本：
  - 在 `packages/rust/ailoom-server/src/services/codex/app_server.rs` 中，将 `@openai/codex@...` 替换为 `@openai/codex@$CODEx_VERSION`（建议后续改为读取 `CODEx_VERSION` 环境变量）。
- 验证：
  - `npx @openai/codex@$CODEx_VERSION --version`（或 `codex --version`）
  - `cargo update -p codex-app-server-protocol --precise <sha>`（可选）+ `cargo check -p ailoom-server`
- CI 守卫：
  - 新增脚本 `scripts/check-codex-version.sh`：读取 `app_server.rs` 中的 npm 版本与 Cargo.toml 中的 `rev`，对照 GitHub tag → commit 的查询结果，若不一致则失败。
- just 任务（示例）：
  - `just codex-pin 0.50.0`：自动查询 commit、批量更新 Cargo.toml 与 app_server.rs 并执行验证。
  - `just codex-verify`：在 CI 执行一致性校验。

### 配套命令与脚本

- `just codex-codegen`：生成前端 TS 类型与 JSON Schema，依赖 `codegen-codex-types` 二进制，默认输出到 `packages/web/src/lib/codex-types/` 与 `docs/specs/codex/`。
- `scripts/check-codex-version.sh`：校验 `CODEX_VERSION` 与 Cargo `rev` 指向同一 `rust-v*` Tag，推荐纳入 CI。

### 客户端强类型化

- 发送端：使用 `codex_app_server_protocol::ClientRequest::*` 构造请求，避免手写字符串方法名。
- 接收端：解析为 `ServerNotification`/`ServerRequest`，在桥接层最小增强后转发给前端。
- 移除自研 `jsonrpc.rs`，统一采用官方 `jsonrpc_lite` 形态（不再包含 `jsonrpc: "2.0"` 字段）。

### 版本固定与升级策略（无降级）

- 通过固定 rev/tag 确保一致性；升级时整体切到新的 `rust-vX.Y.Z`（包括 CLI 与 crates），不做运行时降级。
- 首选官方“新接口族”（如 `account/*`、`model/list`）；对仍标记为 deprecated 但尚无替代的会话类接口，按当前版本协议直接使用，待上游提供替代后统一迁移。

### 前端类型自动生成

- 新增 codegen 步骤：在后端以官方 crate 提供的 `generate_ts`/`generate_json` 导出 TS 与 JSON Schema。
- 输出位置：
  - TS：`packages/web/src/lib/codex-types/`
  - JSON Schema：`docs/specs/codex/`
- 通过 `just codegen-codex-types` 串联；在 `dev-all` 下按需触发（避免无改动时强制重跑）。

### 事件桥接策略

- 详见 `docs/guide/codex-chat-ws-ssot.md`。
- 原则：ServerNotification → `codex/*`（最小增强，补齐 `provider`/`conversationId` 等）；前端集中在 `ws.ts` 归一化后再落地至 `chat.*`。
- 后续规划：保留 `experimental_raw_events` 选项（暂未实现），用于调试面板观察未经映射的通知流。

## 分期计划（Roadmap：Codex‑only）

- Phase 1：Codex‑only 落地（1–2 天）
  - 引入官方 crates（`rust-v0.50.0`），升级 Rust 1.90+
  - 全量替换为官方类型与 `jsonrpc_lite`，移除自研 `jsonrpc.rs`
  - 后端门面与最小 trait、事件 `provider="codex"` 附加、统一 tracing 维度
  - 事件映射覆盖检查日志/测试
- Phase 2：类型生成 + 前端事件迁移（1–2 天）
  - 落地 `just codegen-codex-types`；前端改为使用生成类型
  - WS 事件统一为 `codex/*`，移除旧事件命名与适配层
  - 前端 Query Key 新增 `provider` 维度的用法范式；store 增加 `capabilities`
- Phase 3：可观测性与调试完善（2–4 天）
  - 完善 tracing、背压与 `/debug/codex`
  - 版本一致性脚本与 CI 守卫（`just codex-pin/codex-verify`）
  - 后端最小集成测试骨架（happy path）
- Phase 4：接口升级（按需）
  - 跟随上游提供的新会话接口统一迁移；删除已不再使用的接口调用
（本 Roadmap 仅覆盖 Codex‑only 阶段与与之直接相关的演进。）

## 风险与兼容性

- 工具链：需要 Rust 1.90+ 与 `edition = 2024`；CI/开发机需同步升级。
- 版本一致性：NPM CLI 与 Rust crates 必须保持同一 tag/commit（例如 0.50.0 系列），否则会出现协议不一致。
- 兼容性策略：无向后兼容与降级逻辑，旧版本 Codex 将无法工作（明确在 README/安装指引提示最低版本）。
- 生成类型变更：TS 生成物命名与历史手写类型可能有差异，前端按新生成类型统一调整。

## 验收标准（示例）

- 启动：`just server-dev`，前端 `just web-dev VITE_API_BASE=...`
- 新开会话：成功返回 `conversationId`、`model`，并收到 `codex/sessionConfigured` 事件
- 发送消息：UI 展示 `turn_started` / `turn_finished`，审批流（patch/exec）正常（auto-approve 策略保留）
- 列表/恢复：`listConversations` 可分页；`resumeConversation` 渲染初始消息
- 类型生成：`just codegen-codex-types` 输出 TS/JSON Schema，前端构建通过

## 里程碑与排期（建议）

- M1（P1 完成）：类型对齐与能力协商可用
- M2（P2 完成）：传输适配 + 类型生成接入
- M3（P3 完成）：可插拔后端与事件完善、可观测性
- M4（视需要）：全面切换新接口与清理

## 附录

- 参考依赖片段（Cargo.toml）

```toml
[dependencies]
codex-protocol = { git = "https://github.com/openai/codex.git", package = "codex-protocol", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
codex-app-server-protocol = { git = "https://github.com/openai/codex.git", package = "codex-app-server-protocol", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
```

- 相关文件
  - 后端启动：`packages/rust/ailoom-server/src/services/codex/app_server.rs`
  - 客户端封装：`packages/rust/ailoom-server/src/services/codex/client.rs`
  - 桥接/事件映射：`packages/rust/ailoom-server/src/services/codex/bridge.rs`
- 前端 WS 类型：`packages/web/src/lib/ws/types.ts`
- Codex 聊天前端：`packages/web/src/features/codex-chat/`
- Codex Provider Store：`packages/web/src/stores/codex-chat-provider.ts`
- 现有文档：`docs/guide/codex-chat-ws-ssot.md`、`docs/guide/chat-troubleshooting.md`

- 上游参考
  - 仓库：openai/codex（`codex-rs/protocol`、`codex-rs/app-server-protocol`、`codex-rs/mcp-types`）
  - Tags：`rust-v0.46.0`、`rust-v0.47.0`、`rust-v0.48.0`、`rust-v0.49.0`、`rust-v0.50.0`
