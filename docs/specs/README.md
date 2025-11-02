# 规格文档（specs）

- codex-protocol-integration.md：Codex 协议与类型接入（无向后兼容，Codex‑only）。
- multi-provider-architecture.md：多 Provider 规划与架构（长期演进、汇总版与原地切换）。
- 012-codex-per-conv-runtime-lifecycle.md：Codex per-conv 运行时生命周期与在线状态方案（子进程管理/状态/WS+REST/GC/优雅停机）。

（已吸纳）006-chat-history-and-streams-unification：内容已并入 `docs/guide/codex-chat-ws-ssot.md` 与 `docs/guide/ws-overview.md`，请以 guides 为准。

已迁移：与聊天时间线/WS 架构有关的权威规范已统一迁移至 `docs/guide/`，具体见 `AGENTS.md` 的“架构索引”。

迁移提示：与聊天时间线边界/映射/恢复相关的权威规范已统一迁移至 `docs/guide/codex-chat-turn-ssot.md`，请以该文档为准。

## 未完成（Backlog）

- Chat 视图的轻提示：当 `events.resume` 返回 `truncated=true` 或恢复失败（`resume_failed`）时，除调试面板外，在聊天页给出非打断式提示（与现有 `session.resync` 事件对齐）。
