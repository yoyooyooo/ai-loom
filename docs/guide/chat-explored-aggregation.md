# Explored（读取合并）聚合指南

本指南从“需求视角”和“技术视角”说明前端的“Explored 读取合并”能力：把多次文件读取/列出/搜索命令，视觉上合并为一张大卡片，体验对齐 Codex TUI 的“Explored/List/Read …”摘要。

2025-10 更新（SSoT）：将“timeline 作为唯一事实源（Single Source of Truth）”，snapshot 仅在组件内按需计算。

## 需求视角（WHAT / WHY / 验收）

- 目的
  - 降噪：模型在一个回合内会多次 `ls`/`sed -n`/`rg` 等探索操作。直接逐条显示会形成“卡片风暴”。
  - 对齐 TUI：把连续的“读取/列出/搜索”合并到一张大卡片里（Explored），便于快速扫读。

- 范围
  - 仅“前端视觉合并”，不改变服务端事件，也不影响工具真实执行。
  - 命中解析的命令会归入 Explored 卡片；未命中解析的命令继续按原来的 [exec] 卡片显示（无副作用）。

- 用户体验（渲染）
- 封面：`[explored]`；有在途读取类命令时，追加 ` [Exploring…]`（inflight>0）。
- 正文：严格“按时间顺序”逐行渲染（跨类型也保序）。
  - List 行：`List <basename(target)>`
  - Search 行：`Search <query> in <basename(target)>`
  - Read 行：`Read <fileName> (lines: 1-200, 201-400, …)`（同文件的后续读取“原位更新”该行，不新增第二行）
- 每次分段（见“边界”）都会“冻结当前卡片”，随后命中的读取会新开一张卡。
 - Patch 卡片正文：
   - 多文件：每文件一个折叠块，summary 为路径
   - 单文件：正文直接显示 diff，不再重复路径

- 验收要点
  - 一轮包含若干 `ls`/`sed -n`/`rg` 调用时，界面仅出现一张“[explored] …”卡片，正文列表呈现命令摘要；同名文件分块读取合并成连续区间。
  - 未被解析命中的命令仍以标准 [exec] 卡片显示。
  - 回合结束后卡片状态为“已完成”（不遗留“生成中”）。

## 技术视角（HOW / 算法 / 边界）

- 事件来源
  - 基于 `chat.tool.exec.begin/output/end` 事件，仅在 `exec.begin` 时解析命令并决定是否聚合。
  - 命中“读取类”（read/list/search）时：不创建 [exec] 工具卡，仅更新 explored 的 timeline 与 inflight（并发指示）。
  - 未命中解析 → 维持原逻辑创建 [exec] 卡片，并作为“分段信号”收束上一张 explored。

- 解析规则（启发式，覆盖常见变体）
  - Read（文件读取，按区间合并）：
    - `sed -n 'A,Bp' <file>`、`nl -ba <file> | sed -n 'A,Bp'`
    - `head -n N <file>` → [1..N]
  - List：
    - `ls -la [-R] [dir?]`、`rg --files [dir?]`、`find <dir?> … -type f|d`（仅枚举）
  - Search：
    - `rg -n <pattern> [scope?]`、`grep <pattern> [scope?]`、`fd <pattern> [path?]`、`find <dir?> … -name|-iname <pattern>`
  - 目标目录缺省时：统一回填 `cwd`，UI 显示其末级目录名（如 `chat`）。

- 聚合数据结构（Zustand `explore`，SSoT=timeline）
  - `cardId?: string`：当轮 Explored 卡片消息 id
  - `inflight: string[]`：在途“读取类 exec”的 callId 集合，用作封面 `[Exploring…]` 指示
  - `timeline: Array<list|search|read>`：严格时间顺序的事件流
    - list: `{ ts, kind:'list', label, target }`
    - search: `{ ts, kind:'search', query, target }`
    - read: `{ ts, kind:'read', file, fileName, mergedRanges }`（mergedRanges 为“累计区间”）

> 不再在 store 内持久化 snapshot（reads/lists）；snapshot 在组件内“计算得出”。

  - 纯函数（核心）
  - `mergeRanges(existing, incoming)`：排序+相邻/重叠合并（`[1,200]` + `[200,400]` → `[1,400]`）。
  - `parseExploreActions(command: string[], cwd?: string)`：输出 `read/list/search` 动作列表；未命中返回空数组。
  - 组件内 computed（timeline → snapshot）：
    - 可选 base = lcp(所有 target 与 file)（仅用于渲染友好，非必需）
    - lists：displayTarget 可直接用 `basename(target)`（或按需相对化）
    - files：以 path 聚合 mergedRanges（用于 Read 行显示累计区间）

- 生命周期与收尾
  - 首次命中解析：创建 Explored 卡片（streaming），并 timeline.push 对应事件。
  - 后续命中：timeline 追加；对 read 同一文件，原位更新该 read 行的 mergedRanges。
  - 收尾：`chat.message.completed/failed/aborted`、`chat.turn.complete` → finalize 卡片（并将 inflight 归零）。
  - completed 特别约定：
    - finalize explored → 将过程气泡转为“思考气泡”（清空正文，仅保留 reasoning；若无 reasoning 则移除该气泡）→ 尾插“最终总结”。
  - 并发：读取类 exec.begin/end → inflight++/--，仅用于封面 `[Exploring…]` 提示。

- 配置项
  - `VITE_CHAT_EXPLORE_AGGREGATE=1`（默认开）：启用“读取合并”。

- 边界与回退（“宁可少合并，也不误合并”）
  - 仅当“上一条视觉消息就是开放中的 explored 卡片”时复用；否则新建。
  - 以下任意“分段信号”都会 finalize 当前卡并开启下一段：
    - 非空回答/思考：`chat.message.delta`、`chat.message.completed`、`chat.reasoning.delta`
    - 非读取工具：未命中的 `chat.tool.exec.begin`、`chat.tool.patch.begin`、`chat.tool.mcp.begin`
    - 控制/信息：`chat.message.failed`、`chat.message.aborted`、非空 `chat.info.user_message`
    - 回合屏障：`chat.turn.complete`
  - 解析启发式：未命中解析 → 原生 [exec] 卡片，不丢信息。

- 单元测试
  - 位置：
    - 解析/合并：`packages/web/src/features/codex-chat/utils/explore-utils.test.ts`
    - 聚合/收尾/顺序：`packages/web/src/features/codex-chat/stores/chat.store.test.ts`
  - 覆盖：
    - `mergeRanges`、各类命令解析（ls/rg --files/rg -n/grep/fd/find/head/sed/nl+sed）
    - 严格相邻复用、分段 finalize、timeline 跨类型保序、同文件续读原位合并、finalize 后 generating=false

## 示例

- 输入命令（来自 `chat.tool.exec.begin` 的 command 数组）：
  ```
  [
    'bash','-lc',
    "ls -la packages/web/src && sed -n '1,200p' src/a.ts && sed -n '200,400p' src/a.ts && rg -n 'todo' packages"
  ]
  ```
- 渲染卡片（示意）：
  ```
  [explored] files: 1, ops: 2
  - List ls packages/web/src (x1)
  - Search rg -n /abs/path/to/packages (x1)
  - /abs/path/to/src/a.ts (lines: 1-400)
  ```

## 与 TUI 的关系
- TUI 在自身渲染层也做了合并/去重（parse → normalize → group）。当前实现复刻其思路，但仅覆盖常见命令；复杂/罕见变体回退到原生 [exec] 展示。

## 未来增强
- 解析更多读取/列表模式（如 `cat`/`tail -n`/`find`）。
- 分组小标题与折叠（List/Search/Read 分段）。
- 每项点击跳转到文件视图或“打开该路径”。

---

实现位置：
- 解析/构文/合并（纯函数）：`packages/web/src/features/codex-chat/utils/explore-utils.ts`
- 聚合状态（SSoT=timeline）与动作：`packages/web/src/features/codex-chat/stores/chat.ts`
- 命令解析入口：`packages/web/src/features/codex-chat/services/ws.ts`（`exec.begin` 分支）
- 渲染（封面 computed + 正文按 timeline）：`packages/web/src/features/codex-chat/components/message-item.tsx`
