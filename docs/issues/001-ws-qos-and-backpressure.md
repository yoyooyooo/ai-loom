# 001 — WS QoS 与回压策略（指标/告警/调优)

- 背景：早期 specs 提出了回压/QoS 方向；现实现已具备 priority/file/tree 三路分流 + Pump/Supervisor 自愈，但缺少指标化与系统化调优说明。
- 目标：
  - 指标：Ring 容量占用、丢弃/保留（按通道）、延迟分位、resume 命中率等。
  - 告警：落后超阈值（hub.lastEventId - lastSent）、丢弃比例/窗口过高、Pump backlog 累积。
  - 调优：Ring cap/去重窗口/Pump 周期/Supervisor 阈值的推荐区间与生产经验。
- 验收：
  - 在 `docs/guide/ws-overview.md` 增补“配置与调优”章节；提供默认值、样例与故障定位 checklist。
  - 可选：`/debug` 页面曝光相关指标，便于本地调试。
- 关联：`docs/guide/ws-overview.md`
