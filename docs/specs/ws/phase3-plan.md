# Phase 3 计划（WS 写入灰度）

本阶段目标：
- 文件保存默认优先走 WS（`file.save`），在传输/能力类错误时自动回退 REST，保证“功能不退化”。
- 提供便捷命令与开关，支持纯 WS 验证与灰度观测。
- 用调试面板与路由日志对比首屏/保存时延，确保与 REST 等价或更优。

## 启动方式

- 读取/写入都走 WS（允许回退，推荐验证）：
  - `just dev-ws-write`
- 纯 WS 验证（读取+写入全走 WS，禁用回退/熔断）：
  - `VITE_WS_DEBUG=1 just dev-all-ws`

## 开关说明

- `VITE_WS_WRITE=1`：启用写入（保存）走 WS，配合前端 `wsPrefer` 的自动回退。
- `VITE_WS_NO_FALLBACK`：禁用回退（强制纯 WS 验证）；在 `dev-all-ws` 中默认开启。
- `VITE_WS_FUSE_MS`：短窗熔断时间（毫秒）；在 `dev-ws-write` 中设置为 1500。
- `VITE_WS_DEBUG_ROUTE=1`：打印 WS/REST 路由选择（建议在对比时开启）。
- `VITE_WS_DEBUG=1`：开启调试面板；用于查看 `broadcasts/fileChanged`、`ring` 等指标与趋势。

## 前端行为（已落地）

- `saveFile()` 使用 `wsPrefer('file.save', ...)` 优先走 WS，并在出现传输/能力类错误时回退 REST；
  - 业务错误（如冲突 `CONFLICT`）直接抛出并提示，避免“错误被回退掩盖”。
  - `VITE_WS_NO_FALLBACK=1` 时，走纯 WS（不回退、无熔断），并在首批调用时等待 WS 就绪后再发起。

## 验证步骤

1) 功能等价性
   - 读取：目录树/文件分页/全文/批注列表均稳定；
   - 写入：保存成功/冲突提示/广播 `file.changed` 与后续 `annotations.verify.done` 正常；
   - 断线恢复：保存期间断开后重连，写入路径仍可用（若失败应回退 REST）。

2) 性能观测（本地）
   - 打开面板（`VITE_WS_DEBUG=1`）与路由日志（`VITE_WS_DEBUG_ROUTE=1`），记录：
     - 保存耗时：观察控制台时间戳或在 UI 打点（可选）。
     - 面板 `broadcasts` 与 `fileChangedTotal` 累加是否符合预期。

3) 文件监听（可选）
   - `AILOOM_FSWATCH_ENABLED=1` 开启监听后，外部修改文件 → 前端自动刷新（`file.changed/tree.changed`）。

## 回退与风险控制

- 任一传输/能力类错误（如 `WS_DOWN/TIMEOUT/MESSAGE_TOO_LARGE/WS_DISABLED/NOT_SUPPORTED`）→ 自动回退 REST（非 no‑fallback）。
- 冲突 `CONFLICT` 直接抛出，保持与 REST 行为一致（提示刷新内容后再试）。
- 面板可用作“观察哨”：若 `broadcastErrors` 持续增长或 `ring` 接近上限，应暂停灰度并排查。

## 后续（可选）

- 写入链路的 p50/p90/p99 统计（面板/脚本级）；
- 更细的错误聚合报表（TIMEOUT/WS_DOWN/MESSAGE_TOO_LARGE 等分布）；
- 大文件编辑的分块保存（未来需求）。
