# ai-loom 任务分解（执行指引）

> 目标：在 M0–M3 内完成“文件浏览 + 跨行批注 + Stitch 生成 + MCP 暴露”的最小闭环；前端改为 Vite + Tailwind + shadcn/ui；Rust Workspace 多包化（core/store/fs/stitch/server）。

## 0. 基线与准备

- 骨架来源：cp 自 `templates/vibe-kanban`（已拷贝至 repo `templates/vibe-kanban/`），随后重命名与裁剪。
- 数据目录：`~/ailoom/ailoom.db`（Win：`%USERPROFILE%\ailoom\ailoom.db`）。
- 端口：默认随机（`127.0.0.1:0`），CLI 显示实际端口并自动打开浏览器。

## M0 原型（后端 + 前端壳）

交付目标：能在任意根路径启动，懒加载目录树、分页读取文件并渲染；静态托管前端；npx 一键运行。

步骤

1. Rust Workspace 初始化（packages/rust）
   - 建立 crates：`ailoom-core` `ailoom-store` `ailoom-fs` `ailoom-stitch`（空实现/README/单测夹具）
   - `ailoom-server` 作为 bin，集成 Axum + 路由空壳 + 静态托管
   - 配置 SQLite 连接：WAL、busy_timeout、synchronous=NORMAL
2. REST：`/api/tree` `/api/file`（分页）
   - fs：忽略合并 `.gitignore` + `.ailoomignore`（后者优先），单层列目；二进制判定（含 NUL/解码失败）
   - file：`startLine/maxLines` 支持、软/硬阈值逻辑（2MB/50k、5MB/200k）
3. 前端（packages/web）
   - Vite + React + Tailwind + shadcn 初始化；Monaco 只读查看器；基础路由与布局
   - Explorer：目录树懒加载、文件分页渲染、Loading/空态/错误态
4. CLI（packages/cli）
   - Node 启动器：解压/定位 server 二进制 + web/dist；参数 `--port --db --no-open`；环境 `AILOOM_DB_PATH`

DoD

- 展开 10k+ 文件的目录层级无阻塞；打开 2MB 内文本 <300ms；分页/阈值触发正确
- CLI 一键运行，浏览器自动打开

## M1 批注（CRUD + 回跳 + 导入导出）

交付目标：跨行选区创建/编辑/删除批注，列表回跳；持久化到 SQLite；JSON 导入/导出；抗漂移。

步骤

1. 数据模型与迁移
   - `annotations` 表字段：id, file_path, start_line, end_line, selected_text, comment, tags, priority('P0'|'P1'|'P2'), pre_context_hash, post_context_hash, file_digest, created_at, updated_at
   - 索引：file_path、created_at、(file_path,start_line,end_line,created_at)
2. REST：`/api/annotations*` + 导入/导出
   - 导出包 ExportBundle：schemaVersion、annotations[]、exportedAt
   - 导入策略：按 id 或 `(file_path,start_line,end_line,comment)` 去重；冲突以 updated_at 新者为准；事务 + 报告
3. 前端交互
   - 跨行选区 → 悬浮工具条（新建/复制原文/±1 行/取消）；注解列表 + 回跳
   - 过滤/搜索（file_path/tag/priority）与虚拟滚动
4. 抗漂移与回跳
   - 回跳顺序：位置 → 文本全文匹配 → 指纹；失败标记“可能已漂移”

DoD

- 创建 10+ 批注稳定回跳；重启后可恢复；导入/导出报告包含新增/更新/跳过

## M2 生成器（Stitch + 复制）

交付目标：按照模板 `concise/detailed` 聚合批注并复制；支持 `maxChars` 预算；正确统计与裁剪。

步骤

1. `ailoom-stitch`
   - 模板与排序：priority→file_path→start_line；变量字段与上下文（±3 行）
   - 预算：先截断选中文本，再丢弃低优先级；代码围栏修复；`stats` 输出
2. REST：`POST /api/stitch?templateId&maxChars`，body 可选 `annotationIds[]`
3. 前端 UI：Stitch 面板 + 复制回退（clipboard API / execCommand）

DoD

- 100 条批注生成 <200ms；复制成功 Toast；失败有回退

## M3 MCP Provider（本机、无鉴权）

交付目标：提供 `list_contexts/get_context/stitch` 三工具；仅本机，响应体积限制 256KB；与 REST 契约一致。

步骤

1. `ailoom-mcp` crate（可选编译）
   - 直接访问存储层或通过 REST 代理；分页参数支持；错误码与限制
2. 联调
   - 按 mcp.md 验收：list → get → stitch

DoD

- 客户端可通过 MCP 拉取批注并拼接 Prompt 成功

## 工具与质量

- Rust：cargo test/clippy/fmt；server 集成测试（tree/file/annotations/stitch）
- 前端：Vitest/React Testing Library；基本 e2e（启动 → 打开 → 新建注解 → 生成 → 复制）
- 性能：`/api/tree` 单层 <100ms、文件首屏 <150ms（2MB 内）、Stitch <200ms（100 条）

## 风险与回避

- 极大目录：懒加载 + 速率限制；分页与上限 1000 项
- 符号链接循环：已访问 inode 集合 + 中断上限
- Windows 长路径/编码：路径转换与清晰提示；CRLF 显示验证

---

## MVP 剩余 TODO（按优先级逐项落地）

> 策略调整：优先把“批注 → Stitch → 复制 Prompt”的主流程打磨到稳，用最小 UI；其余外观/设置类能力延后。

### P0（主流程打磨，必须完成）

- [ ] Stitch 面板（最小化 UI，覆盖主流程）
  - 落点：`packages/web/src/routes/explorer.tsx`
  - 能力：模板选择（concise/detailed）、预算输入（maxChars）、仅勾选注解生成（annotationIds）、复制到剪贴板/下载 .txt 兜底。
  - 现状：已有“生成并复制”按钮（默认 `concise`/6000，见 `explorer.tsx`），尚缺模板选择、预算输入、选择子集与 stats 展示/复制回退。
  - 验收：
    - 任意选定批注 → 生成 Prompt <200ms（100 条内）
    - 复制成功（权限不足时展示文本供手动复制）
    - stats 显示 used/total/truncated/chars

- [x] 大文件无感滚动加载完善（基础版完成，待边界验证：节流 + 去重 + Loading）
  - 落点：`packages/web/src/components/editor/MonacoViewer.tsx`
  - 验收：尾部仅一次追加；无重复请求；段信息累计正确；滚动中输入/浮层不抖动。

- [ ] 非 UTF-8/编码识别补齐（UTF‑16/GBK 等）
  - 落点：`packages/rust/crates/ailoom-fs/src/lib.rs`（BOM 与常见编码失败返回专用 code，如 NON_UTF8）；前端提示。
  - 现状：后端当前统一返回 415 + `NON_TEXT`；前端已提示“非文本或非 UTF‑8”。可选择沿用 `NON_TEXT` 并补充文案，或新增 `NON_UTF8` code 并区分提示。
  - 验收：UTF‑16/GBK 文件返回 415 + 专用 code；前端文案明确。

- [x] 注解点击稳定化与“不可聚焦”（已完成）
  - 落点：`MonacoViewer.tsx`（装饰命中 + DOM 捕获层）/ `monaco-overrides.css`（禁用默认激活高亮 + 内联高亮）。
  - 验收：点击黄条只弹浮层；不出现插入符；仅外部点击关闭。

- [ ] 文档与演示脚本（主流程）
  - 落点：本文件与 `docs/specs/planing/mvp-roadmap.md`；新增 5 分钟演示脚本（启动 → 注解 → 生成 → 复制）。
  - 验收：新人 10 分钟内跑通主流程；脚本/截图/GIF 完整。

- [ ] 导入去重策略补齐（无 id 回退键）
  - 落点：`packages/rust/crates/ailoom-store/src/lib.rs::import_annotations`
  - 验收：无 id 的 JSON 导入按 `(file_path,start_line,end_line,comment)` 合并，冲突以 `updated_at` 新者为准；导入报告正确统计新增/更新/跳过。

### P1（增强体验，UI/交互优化）

- [ ] Toast 统一反馈（替换 alert）
  - 落点：`packages/web/src/components/ui/toast.tsx`（新增）/ 全局挂载；替换 `explorer.tsx` 内成功/失败提示。
  - 验收：成功/失败均有统一轻提示，包含 `error.code/message`。

- [ ] 主题切换与记忆（明/暗）
  - 落点：`packages/web/src/app.tsx`（主题状态 + `<html data-theme>`/class 切换）；持久化 `localStorage('ailoom.theme')`。
  - 验收：切换即时生效，刷新后仍保持；编辑器与 UI 同步深色方案。

- [ ] 只读“查找/跳转”入口与快捷提示
  - 落点：`packages/web/src/routes/explorer.tsx` 顶栏加入按钮（⌘/Ctrl+F、⌘/Ctrl+G、⌘/Ctrl+L）；调用 Monaco 内置动作。
  - 验收：点击或快捷键可打开查找/跳转面板；跳转到行准确。

- [x] 小文件编辑与保存冲突处理（已完成）
  - 落点：`packages/web/src/routes/explorer.tsx`（进入编辑/保存）与 `components/editor/MonacoEditorFull.tsx`；后端 `PUT /api/file`（乐观并发冲突 409 + 当前 digest）。
  - 验收：≤512KB 文本可进入编辑并保存；并发冲突时提示刷新；成功保存后 digest 更新。

- [ ] 文件外部变更监听（提示刷新/覆盖）
  - 落点：后端：在 `ailoom-fs` 暴露 `last_modified + digest`；前端：轮询当前文件 digest/mtime 或 SSE（简单优先轮询）。
  - 验收：外部修改后切回页面出现提示；选择“刷新”后只读视图更新。

- [ ] 快速打开（⌘/Ctrl+P）与全局搜索（⌘/Ctrl+Shift+F）
  - 落点：后端新增 `/api/list-files`（尊重忽略）与 `/api/search`（ripgrep）；前端快速面板 + 结果定位。
  - 验收：1 万文件内模糊匹配 <200ms、全局搜索返回命中片段并可跳转。

- [ ] 文件树性能与细节
  - 落点：`packages/web/src/components/explorer/FileTree.tsx` 引入虚拟滚动；键盘导航；展开状态记忆（localStorage）。
  - 验收：大目录滚动流畅；键盘上下/左右可导航；刷新后保持展开态。

- [ ] 注解“内容小部件”Overlay（兜底方案）
  - 落点：`MonacoViewer.tsx` 为每段注解注册 content widget 覆盖文本区域（命中只派发 onOpenMark），与装饰共存。
  - 验收：任何浏览器下点击黄条都不会产生原生选择/光标，仅弹浮层。

### P2（发布与平台）

- [ ] CLI 发布与预编译
  - 落点：`packages/cli` 打包与 npm 发布；多平台预编译（可先纯 Node 版）；支持位置参数 `ai-loom <dir>` 等价 `--root`。
  - 验收：`npx ai-loom <dir>` 即可启动；Windows/macOS/Linux 运行通过。

- [ ] Windows 深入验证与修复
  - 落点：路径大小写/长路径/权限/CRLF 差异专项；Git Bash/PowerShell 双环境。
  - 验收：常见仓库在 Windows 下功能一致；无路径越界与权限异常。

- [ ] 模板清理
  - 落点：确认 `templates/vibe-kanban` 已完全吸收后删除；在 README 与 docs 中移除相关描述。
  - 验收：仓库无冗余模板；文档链路无 404。

### 测试与质量（持续）

- [ ] Rust 集成测试：`tree/file/annotations/stitch`
  - 落点：`packages/rust/ailoom-server/tests/*.rs`；模拟大目录/大文件/二进制/非 UTF-8；编辑并发冲突。
  - 验收：CI 通过；失败日志可读。

- [ ] 前端单测与轻量 e2e
  - 落点：Vitest + RTL；关键组件（MonacoViewer/Explorer/AnnotationList）；e2e：启动 → 打开 → 新建注解 → 生成 → 复制。
  - 验收：核心路径覆盖；开发期回归容易复现。

### 里程碑与演示脚本

- [ ] 演示脚本（5 分钟）
  - 内容：CLI 启动 → 文件树浏览 → 选择高亮/新建注解 → 列表回跳/编辑/删除 → Stitch 生成与复制 → 非文本文件提示 → 大文件滚动加载。
  - 物料：脚本/截图/GIF；对应命令与端口打印。
