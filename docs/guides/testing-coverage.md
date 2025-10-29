# 测试覆盖与执行指南（前后端）

本文聚焦“WS/Resume → 前端状态管理（Store）→ 渲染”的核心链路。目标是：在任何大功能/方案改造后，能快速定位受影响的测试、补齐缺漏、评估影响面。

## 一键测试

- 前端（Vitest）：`just web-test`
- 后端（Rust Workspace）：`just server-test`（或仅某 crate：`just server-test CRATE=ailoom-server`）
- 前后端一键：`just test-all`

分组执行（推荐）：
- 核心链路（WS/Resume→Store，不含 UI 细节）：`just test-core`
- UI 冒烟（可选，避免过度绑定界面）：`just test-ui`

## 测试思路（如何取舍）

- 核心链路优先：WS/Resume 的协议与行为 → Store 的不变量与回放 → 最小 UI 冒烟（保证“看得见”的连续性）。
- UI 细节不过度绑定：界面可能大改，尽量以 Store 断言（turns/steps/reasoning）与 E2E 冒烟替代复杂 DOM 细节。
- 以 006 规范为准绳：SSoT、Turn-first、幂等、按会话 resume、事件入环范围，作为测试断言的“权威语义”。

## 前端测试清单（按主题与文件组织）

目录结构约定（示例）：

```
packages/web/src/
  features/codex-chat/
    __tests__/
      core/  # 核心链路（WS/Resume→Store 等）
      ui/    # UI 冒烟/端到端（尽量少断言 DOM 细节）
    services/
    stores/
    utils/
  lib/ws/
    __tests__/
      core/
```


### WS 客户端与 Resume

- `packages/web/src/lib/ws/__tests__/core/rx-client.test.ts`
  - 去重与游标：按会话 `convLast[cid]` 过滤重复/过期帧；推进游标并持久化（已按 WS URL 做 namespacing）。
  - resume（全局/按会话）：参数形态、tail 语义；全局 resume 仅补 file/tree/annotations，按会话 resume 返回 chat.*。

- `packages/web/src/lib/ws/__tests__/core/query-helpers.test.ts`
  - 主题过滤与匹配（`matchTopic`/filter 规范化）基础校验。

- `packages/web/src/lib/ws/__tests__/core/stats-utils.test.ts`
  - 统计与采样工具的健壮性（边界输入、空集合）。

- `packages/web/src/features/codex-chat/services/__tests__/core/ws.test.ts`
  - 订阅/退订：按会话 filter 切换；会话守卫（只处理当前 cid 的 chat.*）。
  - Codex runtime 元事件：sessionConfigured/auth/rateLimits → Provider Store 覆盖。

- `packages/web/src/features/codex-chat/__tests__/core/ws-reconnect-resume.integration.test.tsx`
  - 断线 → 重连 → 按会话 resume 增量回放，仅融合当前会话；非当前会话帧被过滤。

### Resume → Store 重建 → WS 接续（同一轮）

- `packages/web/src/features/codex-chat/__tests__/core/integration-resume-ws-store.test.tsx`
  - 已完成会话：history 稳定重建，无 Working。
  - 未完成会话：history 仅 user，WS 接续 delta/completed 合并为同一轮（关键修复点）。
  - 新会话：首帧 chat.* 携带 cid 即可渲染。

### 多会话串扰防护

- `packages/web/src/features/codex-chat/__tests__/core/ws-multiconv-switch.test.ts`
  - 会话切换后，上一会话迟到帧不污染新会话；订阅立即切换。

### 边界与特例

- `packages/web/src/features/codex-chat/__tests__/core/resume-tail-late.test.ts`
  - tool.end 晚于 message.completed（同 turnSeq）时保持单轮并聚合。

- `packages/web/src/features/codex-chat/__tests__/core/ws-compact.test.ts`
  - 文本为“Compact task completed”时：仅插入 info 步骤，不结束/不新起轮。

- `packages/web/src/features/codex-chat/services/__tests__/core/delta-streams.test.ts`
  - 缺失 turn.started 的隐式开启（首条 reasoning/answer delta 触发 beginTurn）；微批对 delta 的聚合。

- `packages/web/src/features/codex-chat/__tests__/core/ws-history-guard.test.tsx`
  - 已有 turns 时，迟到的 session.history 不覆盖现有 turns；空态允许填充。

### Store 不变量（收尾与索引）

- `packages/web/src/features/codex-chat/__tests__/core/turns-invariants.test.ts`
  - completeTurn 后：`activeTurnId` 清空、`generating=false`、所有步骤非 streaming、`toolIndex` 清空；收尾状态（failed/aborted）与 assistant 文本。

### Provider 能力与覆盖

- `packages/web/src/features/codex-chat/__tests__/core/resume-config-provider.test.tsx`
  - resume.config → overrides/capabilities 写入默认会话与目标会话；overrides 优先；capabilities.model 来源一致。

### UI 冒烟（最小化）

- packages/web/src/pages/__tests__/chat-page.e2e.test.tsx
  - 路由带会话 → resume → 接收 WS 增量 → 最终渲染更新（轻量端到端）。

### Explorer 缓存失效（WS → React Query）

- `packages/web/src/features/explorer/ws-invalidators/__tests__/core/file-invalidator.test.tsx`
  - `file.changed` 去重与失效：文件快照 + 包含目录的树。
- `packages/web/src/features/explorer/ws-invalidators/__tests__/core/tree-invalidator.test.tsx`
  - truncated/impactedPaths 的目录集合计算与失效；`session.resync` 的兜底刷新。
- `packages/web/src/features/explorer/ws-invalidators/__tests__/core/invalidation-utils.test.ts`
  - `calcMinimalDirs`/`dirname` 的边界用例与归并正确性。

## 变更 → 测试影响映射（如何快速定位）

- 事件协议或入环范围变更（chat.* 映射、eventId 注入、tail 语义）：
  - 优先跑：`rx-client.test.ts`、`ws.test.ts`、`ws-reconnect-resume.integration.test.tsx`
  - 若 tail/after 语义变化，更新 rx-client.test.ts 的 resume 相关断言

- Turn 边界变更（start/complete/fail/abort 的优先级）：
  - 优先跑：`resume-tail-late.test.ts`、`turns-invariants.test.ts`、`ws-edge-cases.test.ts`
  - 检查隐式起轮/收尾的行为是否仍满足 006 规范

- 多会话并发/切换策略调整：
  - 优先跑：`ws-multiconv-switch.test.ts`、`ws-reconnect-resume.integration.test.tsx`

- 工具步骤聚合/渲染策略（exec/mcp/patch 聚合、patch 截断）：
  - 优先跑：`turns-invariants.test.ts`（收尾索引）、ws-tools/patch 用例（如保留）

- Provider 配置与能力来源变更：
  - 优先跑：`resume-config-provider.test.tsx`

## 新增用例建议（优先）

1) WS/Resume/Store 的幂等与不变量（乱序/重复帧、tail 与 live 流的融合、会话切换）
  2) 工具步骤聚合的边界（跨轮 callId、截断策略、空输出）
  3) Provider 侧：HTTP/WS 双来源一致性
  4) 页面级冒烟（需要时开启 fetch 适配器 + MSW 全量拦截）

补充建议（结合实现源码的空白点）：
- `rx-client.ts`：
  - convLast 的持久化隔离（同一浏览器切换不同 `VITE_API_BASE`/WS URL 时 namespacing 不串行）；
  - `codex/event/*` 与 `chat.*` 交错到达时对 lastEventId 的推进不误伤（现实现已仅推进 file/tree/annotations）。
- `delta-streams.ts`：
  - 不同 batch 窗口下的拼接边界（例如 16ms 与 0ms）；
  - Vitest 关闭 Rx 微批时（默认在 `subscribeChatEvents` 中），确保实时路径等价。
- `ws-processors.ts`：
  - 连续多轮间界（多个 `agent_message` 连续结束多轮）；
  - `chat.reasoning.end` 去重规则与标题提取的极端输入（空行/仅符号）。
- `chat-turns-snapshot.ts`：
  - Resume 事件乱序 + 相同 `turnSeq` 的聚合与幂等；
  - `Compact task completed` 场景与其它步骤混入时的附着点选择（空转轮回收）。

## 编写用例的实践技巧

- 模拟 WS：`vi.mock('@/lib/ws/singleton')` + `__emit('chat.*', params)`；断言 Store（`useChatTurnStore.getState()`）而非 DOM。
- 模拟 Resume：`chatTurnActions.loadSnapshot(history, events)`；或调用 `useResumeAndPoll` 并 spy `chatApi.resumeByConversationId`。
- 微批 delta：`ensureDeltaPipelines()` 后注入 `chat.reasoning.delta`/`chat.message.delta`；必要时加 setTimeout 小延时。
- 仅在必要时渲染组件（冒烟）：渲染 `TurnAssistantView` 验证 steps/preview 的存在性，不断言具体 DOM 结构。

## 后端（Rust）测试约定

- 命名与放置：
  - 单元测试：内联 `mod tests`
  - 集成测试：`tests/` 目录
  - 示例命名：`fs_read_conflict`、`store_import_updates`
- 执行：
  - 全量：`just server-test`
  - 指定 crate：`just server-test CRATE=ailoom-server`

## 基础约定（统一语义）

- 所有“可补偿业务事件”统一走 `chat.*`，测试不要依赖 Codex 原始事件。
- Turn-first：按“开始/结束优先级”收敛（`chat.message.completed|failed|aborted` 收尾；必要时 `chat.turn.complete` 幂等确认）。
- 幂等：WS 以 `eventId` 去重；Resume 以顺序 + `turnSeq`（仅 Resume）+ 工具 `callId` 合并。

---

已内置测试分组：`just test-core` 与 `just test-ui`。具体匹配采用目录分层：
- 核心：`src/**/__tests__/core/**/*.{test,spec}.{ts,tsx}`（`vitest.core.config.ts`）
- UI：`src/**/__tests__/ui/**/*.{test,spec}.{ts,tsx}` 与 `src/pages/**/*e2e.test.tsx`（`vitest.ui.config.ts`）

如需更细致的分层，可新增 Vitest project 配置并在 Justfile 中添加对应命令。

## 覆盖现状总评（基于当前测试与源码）

- 核心链路（WS/Resume→Store）：覆盖“隐式开启/收尾、多会话守卫、Compact 特例、Resume 与实时融合”的关键不变量；风险主要集中在极端乱序/截断 + 断线重连交织场景，建议按上文补测。
- WS 客户端：`rx-client` 已覆盖 eventId 去重、会话断点推进与按会话 resume；建议补充本地持久化隔离与跨主机切换验证。
- Store 快照/回放：`buildTurnsFromHistory` 与 `applyEventsToTurns` 路径覆盖良好，已涵盖 exec/mcp/patch/info/plan/thinking 等步骤；建议补充 “相同 turnSeq 的多来源事件幂等”。
- Explorer 失效：文件/树/目录集合计算路径已覆盖，`impactedPaths` 与 `truncated` 分支具备保护；建议补充大集合/深目录性能与精度基准（无需严格 benchmark，至少断言最小集合）。
- UI：保留在“冒烟/端到端”级别，避免与未来 UI 大改耦合；现有覆盖满足验证链路连通性。
