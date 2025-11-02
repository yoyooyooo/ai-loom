# 启用策略与成本控制（Policies）

本文给出“何时启用多 Agent 工作流”的可操作策略，以及 Token/时间成本控制与安全边界。目标：避免“为多而多”，确保在合适场景下才触发工作流。

## 启用准则（建议作为默认策略）

- 规模阈值：
  - 影响文件数 ≥ 5 或跨 FE/BE/TEST → 允许 `febe_parallel` 或 `irtest`。
  - 计划步骤 ≥ 3 且互不依赖 → 允许并行 spawn。
- 风险阈值：
  - 涉及危险工具（exec/patch） → 先走 Reviewer（禁工具），通过后再执行实现/合并。
- 上下文阈值：
  - 单会话上下文已接近窗口上限或噪声大 → 按路径切片交给子 Agent，限制 `inputs.paths`。
- 预算/时限：
  - `limits.budgetTokens` 与 `timeoutSec` 必须在模板内声明；超出则拒绝启动或中止工作流并广播状态。
- 卡壳检测：
  - 连续 2–3 轮无增量/失败 → 允许 spawn Helper/Reviewer 解阻（受预算约束）。

## Token 与时间成本（心智模型）

- 一次 spawn 的额外成本 ≈ 交接摘要 S + 子 Agent 初始注入 B + 子 Agent 自身工作 W；
  - S 通常 0.5–2K；B 1–3K 起；W 视任务而定。
- 并行能缩短墙钟时，才建议开启；串行小任务保持单 Agent。

## 交接最小化策略

- 只传 objective + paths + refs，避免全文注入；子 Agent 按需读取文件（`file.getChunk/getFull`）。
- 子 Agent 回报以结构化摘要（变更摘要/关键决策）；必要时附文件路径而非全文。

## 安全与审批

- 子 Agent 继承父会话的 `approvalPolicy/sandbox`；不得放宽权限。
- Reviewer 默认禁用 exec/patch；实现/合并 Agent 受限在白名单路径下行动。

## Ring 与事件风暴

- 多子会话并发会放大事件量：
  - 调整 `AILOOM_WS_RING_CAP`（如 ≥ 4096）。
  - 工具输出节流/聚合（例如合并连续输出片段）。
  - 仅持久必要增量，遵循 006 列表。

## 可观测性与回溯

- 记录每次工作流的 token/时长/事件数，并与单 Agent 对照；沉淀“何时值得”的数据阈值。
- 关键事件：`chat.workflow.step.begin/end`、`chat.agent.spawned/report/status`。

