# Phase 2 验收与压测清单（可直接照抄执行）

目标：验证“事件去重与优先级、增量恢复、订阅/失效增强、观测指标与开关”在本地环境下达标，并生成可留存的证据（日志/截图/指标）。

前置说明：

- 后端与前端均已实现 Phase 2 功能；部分行为需通过环境变量开启。
- 本清单按“准备 → 三个核心用例 → 记录与结论”的顺序组织。

---

## 0. 准备

在仓库根执行（推荐单终端联动）：

```bash
# 安装依赖（仅首次）
just web-install

# 启动（单终端联动）
just dev-all PORT=63000

# 或者分终端：
# 终端A：just server-dev PORT=63000
# 终端B：just web-dev VITE_API_BASE=http://127.0.0.1:63000
```

建议前端同时开启：

```bash
# 在启动前端的同一命令行中添加：
VITE_USE_WS=1 VITE_WS_DEBUG=1
```

说明：

- `VITE_USE_WS=1` → 读取优先 WS；断线/超时/MESSAGE_TOO_LARGE 回退 REST
- `VITE_WS_DEBUG=1` → 显示 WS 调试面板（在线状态、事件速率、周期趋势、服务器统计）

---

## 1. 监听风暴压测（tree.changed 合批/截断）

开启监听（仅本轮终端需要）：

```bash
export AILOOM_FSWATCH_ENABLED=1
export AILOOM_FSWATCH_BATCH_MS=300
export AILOOM_FSWATCH_MAX_WINDOW_MS=1000
export AILOOM_FSWATCH_MAX_IMPACTED=200

# 如需忽略 .gitignore/.ailoomignore（默认1=开启）
export AILOOM_FSWATCH_IGNORE_VCS=1
export AILOOM_FSWATCH_IGNORE_AILOOM=1
```

触发 1k 文件变更（新开终端执行，根目录下）：

```bash
scripts/fs-burst.sh . 1000
```

期望与记录：

- 面板“树批次 tree.batches 增量”和“broadcasts 增量”出现尖峰；
- ring 紧张时，“droppedLowPri 增量”上升（低优先 tree.changed 的 ring 丢弃）；
- UI 目录树无风暴（刷新次数可控、渲染无明显卡顿）。

留档：

- 截图 面板趋势（包含最近 10 个周期的折线与增量标签）；
- 后端日志片段（包含统计输出与 `ws` 方法耗时/升级/关闭日志）。

---

## 2. REST 写压测（file.changed 广播与 RTT）

在有 AILOOM_PORT 的环境变量下执行（或者替换为后端端口）：

```bash
AILOOM_PORT=63000 node scripts/save-burst.mjs 63000 500 32
```

期望与记录：

- 面板“broadcasts 增量”上升、“fileChangedTotal 累加增长”；
- 脚本输出 p50/p90/p99 在可接受范围；
- 页面行为稳定（无风暴）。

留档：

- save-burst 脚本输出（复制粘贴）；
- 面板截图（broadcasts/fileChangedTotal 概览）。

---

## 3. 断线恢复（events.resume 与粗粒度刷新）

操作（任选一种）：

- 暂停后端 5–10s 后恢复；
- 临时断开网络 5–10s 后恢复；

观察与期望：

- 重连后，若 ring 足够：**自动增量补发**（resume），UI 数据保持一致；
- 若 ring 不足：面板 `resync count` 递增，触发一次“粗粒度刷新当前视图根”。

留档：

- 面板 resync 次数变化与统计时间戳 ts；
- 关键页面刷新效果截图。

---

## 4. 结论与勾选

请在完成三条验证后，补全本小节（示例）：

```text
[ ] 监听风暴压测：
    - 执行时间：2025-10-xx xx:xx
    - 面板截图：images/phase2-listen-burst.png
    - 观察：tree.batches/broadcasts 出现尖峰；droppedLowPri 在 ring 紧张时有增量；UI 稳定
    - 结论：通过/需调整（如需调整参数或 ring 容量）

[ ] REST 写压测：
    - 脚本输出（p50/p90/p99）：（粘贴）
    - 面板截图：images/phase2-save-burst.png
    - 结论：通过/需优化

[ ] 断线恢复：
    - 操作：暂停后端 X 秒
    - 面板：resync 次数 +1；ts 正常递增
    - 结论：通过/需排查
```

达到“通过”条件后，即可将 `docs/specs/ws/tasks.md` 中 Phase 2 的“压测/回归”与“验收用例（Phase 2）”项勾选，并进入 Phase 3。
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVconnect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
VVVVVVVVVVconnect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
connect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVconnect @ http://localhost:5173/src/lib/ws/rx-client.ts:26
WsRxClient @ http://localhost:5173/src/lib/ws/rx-client.ts:20
ensure @ http://localhost:5173/src/lib/ws/singleton.ts:27
get online$ @ http://localhost:5173/src/lib/ws/singleton.ts:43
(anonymous) @ http://localhost:5173/src/lib/ws/ws-debug-panel.tsx:37
commitHookEffectListMount @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:16915
commitPassiveMountOnFiber @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18156
commitPassiveMountEffects_complete @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18129
commitPassiveMountEffects_begin @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18119
commitPassiveMountEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18109
flushPassiveEffectsImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19490
flushPassiveEffects @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19447
performSyncWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18868
flushSyncCallbacks @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:9119
commitRootImpl @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19432
commitRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:19277
finishConcurrentRender @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18805
performConcurrentWorkOnRoot @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:18718
workLoop @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:197
flushWork @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:176
performWorkUntilDeadline @ http://localhost:5173/node_modules/.vite/deps/chunk-NLPXRUV7.js?v=cebf68ab:384
