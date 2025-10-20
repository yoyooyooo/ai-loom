# 本地文件监听与推送（初稿）

目标：监听 `AppState.root` 下文件系统变更，按订阅过滤与合并策略推送到前端，实现“实时但可控”的 UI 同步。

注意：该能力在 Phase 2 才会启用；Phase 1 以“写后广播”达成实时一致，不开启监听以降低改造复杂度与风险。

## 技术选型

- crate：`notify` 推荐使用 `RecommendedWatcher`；权限/平台受限时回退 `PollWatcher`（建议轮询间隔 ~1000ms）。
- 作用域：仅监听沙箱根（`--root`）内；合并 `.gitignore` 与 `.ailoomignore` 过滤噪音与大目录。

## 事件归一化

- 路径：绝对 → root 相对；分隔符统一为 `/`；过滤掉根外路径与忽略项。
- 变更类型：统一投影为四类：`created`、`modified`、`deleted`、`moved`；无法可靠识别移动时退化为 `deleted + created`。
- 时间戳：`ts` 使用 RFC3339 UTC 字符串。

## 合并与节流（要解决的问题）

- 背景：大批量文件操作（如 `git checkout/pull`、依赖安装、编辑器临时文件写入）会在极短时间内触发成百上千个 FS 事件，且包含大量重复/冗余变更，直接逐条推送会造成 UI 抖动、CPU/内存浪费与网络风暴。
- 目标：通过时间窗口内的收集、去重与归并（含移动识别），把“很多碎事件”合成为“少量有意义的摘要事件”，并在数量超阈值时只下发摘要（`summary.truncated=true`）。
- 结果：保证“实时可感知”的同时，避免前端/网络被瞬时冲击压垮，维持交互可用性。

- 防抖窗口：200–500ms 收集一批事件（推荐默认值：300ms），进行归并：
  - 去重：同一 `path` 的多次 `modified` 合并为一次；`created` 覆盖 `modified`；`deleted` 覆盖其它。
  - 移动识别：同一窗口内 `deleted(A)` 与 `created(B)` 且近邻时，归并为 `moved{ fromPath:A, path:B }`。
- 批量上限：每个窗口最多 200 个 `impactedPaths`（推荐默认值）；超出则仅推送 `summary` 并置 `truncated: true`。最大合并窗口建议 ≤ 1s（超时则立即出批）。

## 事件与载荷

- `file.changed`（面向具体文件订阅）
  - 载荷：`{ path, kind: 'created'|'modified'|'deleted'|'moved', fromPath?, ts }`
  - 说明：保存成功路径可携带 `digest`；监听触发一般不读内容/不算 `digest`。若同一时间窗口内既收到“写后广播（带 digest）”又收到监听事件，前端应以带 `digest` 的事件为准，忽略同路径的监听事件，避免重复刷新。服务端 Hub 可对同 key 的监听事件标记 `reduced=true` 或直接丢弃，以进一步降低前端判定成本。
- `tree.changed`（面向目录/全局订阅）
  - 载荷：`{ dir?: string, impactedPaths?: string[], summary?: { created, modified, deleted, moved, truncated }, ts }`
  - 说明：可不带 `dir` 表示整棵树可能受影响；当前实现按根级粒度推送，前端据 `impactedPaths` 选择性失效。

## 配置项（建议命名）

- `fsWatch.enabled: boolean` 是否启用监听（Phase 2 起默认可开启）。
- `fsWatch.batchMs: number` 短窗口合并时间（建议 300ms，可调）。
- `fsWatch.maxWindowMs: number` 最大合并窗口（建议 ≤ 1000ms）。
- `fsWatch.maxImpactedPaths: number` 单批次最大路径数量（建议 200，超出置 `summary.truncated=true`）。
- `fsWatch.ignore.vcs: boolean` 是否合并 `.gitignore`（默认 true）。
- `fsWatch.ignore.ailoom: boolean` 是否启用 `.ailoomignore`（默认 true，高优先级）。

## 路径范围与 Workspace 映射

- 进程存在两个相关概念：
  - `workspace_root`：通过向上查找 `.git` 推断的仓库根（用于 DB `workspaces` 作用域与路径归一），见 `packages/rust/ailoom-server/src/paths.rs:discover_workspace_root`。
  - `root`：本次服务的沙箱根（`--root`），前端所有路径参数与响应一律“root 相对”。
- 监听范围：默认监听 `root`（而非 `workspace_root`），避免无关噪音与越权；若发生跨根移动：
  - 从根外移入根内：会收到 `created`（`fromPath` 可能缺失）；
  - 从根内移出根外：会收到 `deleted`。
- 映射关系：
  - 事件载荷 `file.changed.path` 与 `tree.changed.impactedPaths` 必须是“root 相对路径”（与 REST/WS 读取保持一致）。
  - 涉及 DB（如批注校验）时，使用 `to_workspace_relative`/`from_workspace_to_root` 在 root↔workspace 间映射。
  - 若 `root` 即 `workspace_root`，两者等价，无需转换。

## 订阅与过滤

- `file` 主题：`{ path?: string, prefix?: string }`；`path` 优先于 `prefix`；两者皆空表示全部文件。
- `tree` 主题：`{ dir?: string }`；不带 `dir` 表示关注全局目录树。
- 过滤生效顺序：连接级订阅 → 主题级过滤 → 广播时快速跳过不匹配连接。

## 后端结构（与 WS 集成）

- `ws::watch`
  - 负责监听与事件批处理（合并/节流）
  - 将合并后的事件转换为 `Event{ topic, method, params }` 交由 `ws::hub` 广播
- `ws::hub`
  - 维护 `topic → connections` 索引；按过滤条件定向推送
  - 回压：有界队列；低优先级事件可丢弃/合并（记录计数与丢弃数）

## 前端处理建议

- `file.changed` 命中当前打开文件：
  - 若编辑器无本地改动：直接 `invalidateQueries(['file', path])`
  - 若有本地改动：提示外部变更，提供“刷新/对比/覆盖”操作
- `tree.changed`：
  - 若提供 `impactedPaths`：定位到受影响的目录层级，精确失效对应 `['tree', currentRoot, dir]`
  - 否则：退化为失效根当前视图的目录树查询

## 前后端协同处理策略（impactedPaths）

- 统一语义
  - `impactedPaths` 为“root 相对”的文件/目录相对路径列表，代表本合并窗口内受影响的具体路径；可能被截断。
  - `summary.truncated=true` 表示因超出上限未完整下发路径清单，此时客户端应执行“粗粒度刷新”。

- 客户端处理原则
  - 未截断（truncated=false 且有 impactedPaths）：
    - 将路径映射到“最小目录集合”（取每条路径的父目录，去重与归并父子关系，仅保留最上层需要刷新的目录）。
    - 用 React Query 精确失效这些目录键：`invalidateQueries({ queryKey: ['tree', currentRoot, dir] })`。
  - 已截断（truncated=true 或缺少 impactedPaths）：
    - 执行粗粒度刷新：失效当前可见根或用户正在浏览的 `currentDir` 对应的目录键；必要时失效全局目录缓存。
  - 防抖批量：将同一批事件导致的多个失效合并在一个宏任务中执行，避免重复渲染。

- 示例（前端）
  ```ts
  // 从 impactedPaths 计算最小目录集合
  function calcAffectedDirs(paths: string[]): string[] {
    const dirs = new Set(paths.map(p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'))
    // 归并父子：移除被更上层包含的目录
    const sorted = Array.from(dirs).sort((a,b) => a.length - b.length)
    const res: string[] = []
    for (const d of sorted) { if (!res.some(x => d === x || d.startsWith(x + '/'))) res.push(d) }
    return res
  }

  // 处理 tree.changed 事件
  function onTreeChanged(ev: { dir?: string; impactedPaths?: string[]; summary?: any }) {
    const isTruncated = !!ev?.summary?.truncated
    if (!isTruncated && ev.impactedPaths && ev.impactedPaths.length) {
      const dirs = calcAffectedDirs(ev.impactedPaths)
      batchInvalidateDirs(dirs)
    } else {
      // 粗粒度刷新：失效当前视图根或 '.'
      const dir = useAppStore.getState().currentDir || '.'
      const root = useAppStore.getState().currentRoot || ''
      qc.invalidateQueries({ queryKey: ['tree', root, dir] })
    }
  }

  function batchInvalidateDirs(dirs: string[]) {
    // 简单串行；也可做去重与节流
    for (const d of dirs) qc.invalidateQueries({ queryKey: ['tree', d] })
  }
  ```

- 订阅与过滤协同
  - 服务器可根据订阅的 `tree:{ dir }` 预过滤 `impactedPaths`（仅下发订阅目录下的路径），降低带宽；客户端仍应以 `startsWith(dir + '/')` 自查，防御异常。
  - 当 `impactedPaths` 被预过滤且 `truncated=false` 时，客户端通常只需刷新该订阅目录，无需波及其它目录。

- 与 file.changed 的关系
  - `tree.changed` 仅用于刷新目录结构/展开状态，不应直接触发文件内容重新加载；文件内容刷新由更精确的 `file.changed` 驱动。
  - 若 `tree.changed.summary.truncated=true` 且当前打开的文件位于受影响目录，为稳妥可在空闲时触发一次轻量校验（例如对当前文件做一次 digest 对比或等待 `file.changed`）。


## 跨平台注意事项

- Windows 大小写敏感性差异：统一转为保存时的规范路径；避免误判。
- 符号链接：默认不跨越沙箱根处理；如需支持，需追加循环检测与路径归一。
- 超长路径：尽量使用 Rust PathBuf 原生 API，避免手写拼接。

## 验收要点

- 批量文件操作（如 `git checkout`）不引起 UI 风暴（事件合并与上限生效）。
- 单文件保存后能在 <200ms 内收到 `file.changed` 并刷新当前视图。
- 忽略规则生效：忽略的路径不触发推送。
 - 配置项生效：调整 batch/window/上限后，事件合并与 `truncated` 行为符合预期。
