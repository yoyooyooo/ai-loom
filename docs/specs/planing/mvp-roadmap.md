# ai-loom MVP 路线图（可落地）

## 1. 目标与原则

- 目标：在桌面本机提供“文件浏览 + 跨行批注 + 聚合生成指令 + MCP 暴露”的最小可用闭环。
- 原则：
- 只做 Annotation 一类上下文；AST/结构化摄取仅预留接口，不实现。
- Rust 后端 + SQLite 本地持久化；前端 React + Vite + TailwindCSS + shadcn/ui + Monaco（只读）。
  - npx 一键运行（默认允许联网）；仅 127.0.0.1 本机访问；路径沙箱。
  - 数据与缓存目录：`~/ailoom`（Windows：`%USERPROFILE%\\ailoom`），数据库文件名：`ailoom.db`，多平台路径兼容。

## 2. MVP 范围（Scope）

- In Scope（必须）
  - CLI：`npx ai-loom` 一键运行（或 `ai-loom [path]` 本地启动）。
  - 文件浏览：懒加载目录树（当层）、文件内容查看（Monaco 行号+高亮）。
  - 批注：跨行选区 → 新建/编辑/删除/列表 → 回跳定位。
  - 生成器：按模板（concise/detailed）聚合批注为 Prompt，复制剪贴板。
  - 持久化：SQLite `annotations` 表；JSON 导入/导出。
  - MCP（只读）：`list_contexts`/`get_context`/`stitch`（仅 annotation）。
- Out of Scope（非必须，预留）
  - AST/ctags 结构化摄取、代码图谱与 FTS 检索。
  - 多用户/协作、Patch 生成与自动变更应用、在线 LLM 调用。

## 3. 架构选型（MVP）

 - 后端（Rust/Axum）：REST + 静态托管（/api/tree、/api/file、/api/annotations、/api/stitch）。
  - 存储（SQLite + sqlx）：自动迁移；数据库文件位于用户目录 `~/ailoom`；文件根路径白名单；响应体积/时间限制。
 - 前端（React + Vite + Tailwind + shadcn/ui + Monaco）：只读查看器 + Decorations；悬浮工具条；批注列表与回跳。
 - 分发（npx）：首次安装与运行默认可联网；打包后端二进制 + 前端 dist 至 zip；临时目录运行；自动打开浏览器。
 - 安全：仅 127.0.0.1；路径 realpath 校验；敏感默认 internal；MCP 不直出 secret，且 MVP 阶段 MCP 无鉴权（本机信任）。

## 4. 里程碑与 DoD

- M0 原型（1 周）
  - 内容：文件树（懒加载）、文件内容查看、静态托管、npx 运行。
  - DoD：可在任意目录启动并浏览文件（>10k 文件也可逐层展开）。
- M1 批注（1 周）
  - 内容：跨行选区、批注 CRUD、装饰高亮、回跳、SQLite 持久化、导入/导出。
  - DoD：创建 10+ 批注并可稳定回跳；重启后批注可恢复。
- M2 生成器 + 复制（0.5 周）
  - 内容：模板（concise/detailed）、生成 Prompt、复制剪贴板、统计信息。
  - DoD：100 条批注生成 < 200ms；复制成功 Toast；失败有回退。
- M3 MCP Provider（0.5–1 周）
  - 内容：`list_contexts`/`get_context`/`stitch` 工具；仅本机访问；无鉴权（MVP）。详见 docs/specs/mcp.md。
  - DoD：客户端可通过 MCP 拉取批注并拼接 Prompt 成功。

## 5. 任务拆解（按优先）

1) 基础骨架与分发
  - 复制模板骨架（Rust/Axum + SQLite + npx）并重命名为 `ai-loom`。
   - 数据库迁移：`annotations` 表（id, file_path, start_line, end_line, selected_text, comment, tags, priority, created_at, updated_at）。
2) 文件树与查看器
   - `/api/tree?dir=.` 懒加载一层；忽略 `.git`、`node_modules`、二进制；支持 `.gitignore` 与 `.ailoomignore` 合并，且 `.ailoomignore` 优先级更高。
   - Monaco 只读查看器：行号+高亮；大文件策略（见“默认阈值”）：
     - 软阈值：文件大小 > 2MB 或行数 > 50k → 启用“大文件模式”（纯文本、高亮降级、禁用 minimap/语义高亮、分段加载）。
     - 硬阈值：文件大小 > 5MB 或行数 > 200k → 拒绝全量加载，仅支持分页（`/api/file?startLine&maxLines`）。
3) 批注系统
   - 前端：跨行选区 → 悬浮工具条（新建/复制原文/±1 行/取消）；批注列表与回跳。
   - 后端：`/api/annotations` CRUD；JSON 导入/导出；行号与选中文本校验。
     - 导入定义：从导出的 JSON（含 `schema_version`）写回到本地库，默认合并策略：
       - 去重键：`id` 优先；无 `id` 时以 `(file_path,start_line,end_line,comment)` 指纹去重。
       - 冲突：以 `updated_at` 新者为准；保留一条并记录合并计数。
       - 实现：单事务导入，WAL 模式，导入报告返回新增/更新/跳过数量。
     - 抗漂移：持久化 `pre_context_hash`、`post_context_hash`（各 ±3 行）、`file_digest`；回跳时按 位置→文本→指纹 三段匹配，失败时标记“可能已漂移”。
4) 生成器与复制
   - `/api/stitch`：按 templateId（默认 `concise`）聚合；返回 `prompt + stats`。模板语义见“模板定义”。
   - 前端复制回退方案（clipboard API / execCommand）。
5) MCP Provider（只读）
  - 工具：`ai-loom.list_contexts`（kind=annotation）、`ai-loom.get_context`、`ai-loom.stitch`。
   - 安全：仅本机；MVP 阶段不启用鉴权；限制返回体积与速率。
6) 打磨与排障
   - 键盘可达性；错误提示；端口冲突与大文件策略；日志与最小诊断页。

## 6. 验收脚本（手工）

1) 运行 `npx ai-loom` → 浏览器自动打开。
2) 展开大目录（>10k 文件）逐层无阻塞；打开 2MB 以内文本 < 300ms。
3) 创建 3 条跨行批注，重启后仍可回跳定位；导出/导入批注成功（返回导入报告：新增/更新/跳过）。
4) 生成 Prompt（concise），复制成功；统计显示正确。
5) 通过 MCP：list → get → stitch 三步跑通，并返回可用 Prompt（本机、无鉴权）。
6) 忽略规则：同目录存在 `.gitignore` 与 `.ailoomignore` 时，验证 `.ailoomignore` 的优先级更高。
7) 大文件：验证软阈值触发“大文件模式”，硬阈值触发分页/拒绝全量；提示与交互清晰。

## 7. 风险与缓解

- 大目录 IO 压力：懒加载 + 忽略规则 + 限流。
- 选区失效：存 `selectedText` + 上下文校验；失效标记与人工修复。
- 首屏包体积：Monaco 语言按需 + 禁用 minimap/语义高亮；延迟加载编辑器模块。
- 分发兼容：多平台二进制打包与权限；数据库自动迁移与原子写。
- 跨平台：Windows 路径与 CRLF 兼容；长路径/权限问题回退处理；代码页与控制台输出验证。

## 8. 时间预估（理想人日）

- M0：5d；M1：5d；M2：2–3d；M3：3–5d（含客户端联调）。

## 9. 后续演进接口（仅预留，不实现）

- Ingestors/Index：AST/ctags/tree-sitter → ContextItem（code_symbol/api_route/...）。
- `/api/contexts*` 与 FTS 检索；Stitch 预算档（minimal/concise/detailed）。
- SSE `/api/stream` 推送批注变更；Context Pack 导出/安装。

## 10. 模板定义（MVP）

- 目标：将“批注上下文”稳定、可控地聚合为可复制的 Prompt，满足“快速概览（concise）/全面复现（detailed）”两类主要需求。
- 共同约定：
  - 排序：按 `priority`（P0→P2）降序，再按 `file_path` 升序，文件内按 `start_line` 升序。
  - 字段：`file_path`、`[start_line,end_line]`、`comment`、`selected_text`（必要时截断）、`tags`。
  - 上下文：可选附带选区前后各 ±3 行（按需截断）。
  - 预算：可通过 `/api/stitch?maxChars=` 限制总长，超限时按排序依次裁剪（先截断 `selected_text`，再丢弃低优先级）。

- concise（精简版）
  - 结构：顶层给出“任务背景/约束摘要”（可选），随后为短条目列表（每条 1–3 行）。
  - 每条包含：文件路径#起止行、1 句 comment 要点、选中文本的关键片段（≤120 字符，必要省略号）。
  - 适用：作为外部 LLM 的高效上下文，目标 < 3,000 字符。

- detailed（详尽版）
  - 结构：按文件分组，逐条罗列注解，保留更完整的 `selected_text` 与上下文（每条最多 ~40 行）。
  - 每条包含：文件路径#起止行、comment 全文、`selected_text`（可含上下文 ±3 行），`tags/priority`。
  - 适用：需要外部参与者完整理解与复现，目标 < 15,000 字符（可调）。

示例返回（简化）：
```
{
  "prompt": "...聚合后的文本...",
  "stats": {"annotations": 23, "chars": 5123, "files": 8, "truncated": true}
}
```

## 11. 默认阈值与限制（MVP）

- 文件视图
  - 软阈值：大小 > 2MB 或 行数 > 50k → 大文件模式（纯文本、高亮降级、分段加载）。
  - 硬阈值：大小 > 5MB 或 行数 > 200k → 拒绝全量，仅分页（`startLine/maxLines`）。
  - `/api/file`：支持 `path`、`startLine`（默认 1）、`maxLines`（默认 2000，最大 5000）；返回 `{ content, totalLines, truncated }`。

- 目录/忽略
  - 忽略规则：合并 `.gitignore` 与 `.ailoomignore`，后者优先；默认还忽略 `.git/`、`node_modules/`、常见二进制后缀。

- MCP
  - 仅本机回环；MVP 无鉴权；`stitch` 支持 `maxChars`；默认返回体积上限 256KB。

- 日志
  - 仅命令行（stdout/stderr）输出；默认 `INFO` 级；通过 `--log-level` 切换；不落盘。

- 数据目录
- SQLite 与导入/导出默认路径：`~/ailoom`（Windows：`%USERPROFILE%\\ailoom`）；数据库文件：`ailoom.db`。

- Windows 支持
  - 路径分隔与大小写兼容；CRLF 正常显示；长路径场景启用兼容策略；控制台编码校验通过。
