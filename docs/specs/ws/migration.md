# 实施路线（阶段里程碑，初稿）

## Phase 1：基础落地（MVP）

- 后端：新增 `/ws`，落地读取类方法 `tree.get`、`file.getChunk`、`file.getFull`、`annotations.list`；写路径仍走 REST，但在写成功后广播 `file.changed(kind:'modified',digest?)`、`annotations.created|updated|deleted`（仅写路径广播）。
- 前端：新增 `ws` 客户端与 `wsPrefer` 查询辅助（`VITE_USE_WS=1` 时启用 WS）；读取类优先 WS，传输失败/超时/能力不足自动回退 REST；写入仍走 REST。仅提供 `singleton`（多连接/registry 留待 Phase 3）。目录树 QueryKey 统一为 `['tree', root, dir]`（顶层 `dir='.'`），页面预热也按此。
  - 清单（对齐/替换）：
    - 将所有 `tree` 相关两段式 Key（如 `['tree', dir]`）统一替换为三段式 `['tree', root, dir]`，覆盖页面预热、ensureQueryData、useIsFetching 等路径。
    - 在全局 store 引入 `currentRoot`（默认等于当前服务 root），供三段式 Query Key 与订阅/失效器使用；对内保留 `currentDir` 表示当前视图目录。
    - 批量更新 `useIsFetching`/`invalidateQueries` 的筛选谓词：同时匹配 `root` 与 `dir` 两段参数。
    - 新增中心化失效器：`src/lib/ws/query-invalidator.ts`（raf 批处理、最小目录集合计算、按事件路由失效）。
    - 新增订阅挂载：`src/lib/ws/use-ws-subscriptions.ts`（由当前 UI 状态驱动 topic 订阅，仅维持订阅，不处理事件）。
    - `wsPrefer`：实现“能力不足/传输类错误”回退、支持取消（AbortSignal）、短窗熔断（连续超时/断线后 10s 优先 REST 并周期性探测 WS）。
    - 订阅 API 示例统一为 `subscribeTopic$('file'|'tree'|'annotations', filter?)`；如需多方法筛选，在流内按 `method` 过滤，避免传入方法名数组。
- 验证：对比 WS 与 REST 的数据/错误完全一致；关键交互与性能不回退。
- 文件监听：本阶段不启用 FS 监听，避免变量过多，先验证“写后广播 + 订阅触发失效”。
- WS/REST 等价性：WS `maxMessageBytes` 设为 ≥ 6MB；当个别响应仍触发 `MESSAGE_TOO_LARGE` 时由前端 `wsPrefer` 将其视为“能力不足”并回退 REST；若回退 REST 仍 `OVER_LIMIT/HTTP_XXX`，则按 REST 错误提示并终止回退。

## Phase 2：事件与订阅拓展

- 增加 `subscribe/unsubscribe`；完善推送事件：`tree.changed`（含 summary/impactedPaths）、`annotations.verify.done`、（可选）`stitch.progress`（阶段化、可关闭）。
- React Query 驱动的精确失效与缓存直改；减少主动拉取。
- 引入 FS 监听（`notify`），启用节流/合并与上限；与订阅过滤协同降低噪音。
  - 明确“digest 事件优先于监听事件”：当写后广播与监听事件同时影响同一路径时，客户端以带 `digest` 的事件为准（服务端可在 Hub 层做去重/标记）。

## Phase 3：Hybrid 完整化（WS 主 + REST 保留）

- WS：完善读取方法与订阅推送；可选提供写方法（与 REST 等价）。
- REST（保留清单）：
  - `PUT /api/file`
  - `POST/PUT/DELETE /api/annotations/*`
  - `GET /api/annotations/export`、`POST /api/annotations/import`、`POST /api/annotations/verify`
  - `POST /api/stitch`
  - 读取端点作为兜底仍保留（供脚本/诊断使用）

## Phase 4：优化与扩展

- 大消息优化：分片/流式、MessagePack、批量请求
- 更细粒度的并发与背压控制、可观测性完善
 - 目录级/前缀级订阅、基于文件 diff 的推送（可选）

## 验收与开关

- 验收：
  - 功能等价、断线重连/订阅恢复、`wsPrefer` 回退有效、推送节流有效、性能不劣化、安全边界保持
  - Query Key 一致性：仓库无两段式 `['tree', currentDir]` 残留；预热与组件查询一律使用 `['tree', root, dir]`
  - 事件去重：同一路径的“写后广播（带 digest）”与“监听事件（无 digest）”仅触发一次有效刷新
- 开关：通过前端环境 `VITE_USE_WS=0/1` 切换通道优先级，便于诊断与对比
