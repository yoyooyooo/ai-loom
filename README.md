AI Loom（Ailoom）——本地代码与文档探索器
====================================

English: README.en.md

它是什么
- 本地运行的“代码/文档探索 + 批注 + 轻量编辑”工具：在浏览器中浏览项目文件、分页查看/预览 Markdown、添加批注并快速回跳；小文件可直接在页面内编辑与保存。
- 后端使用 Rust/Axum，前端使用 React/Vite；安装即用，无需联网。
- 数据保存在本机 SQLite：默认 `~/ailoom/ailoom.db`，失败回退到项目根目录 `.ailoom/ailoom.db`；数据库在同一实例内按“工作区（按最近的 .git 或 root 路径规范化）”隔离。

功能亮点
- 资源管理：左侧目录树（懒加载，展开记忆），遵循 `.gitignore` 与可选 `.ailoomignore`。
- 文件查看：大文件分页加载（默认每页 ~1000 行）；语法高亮；Markdown 全文预览（自动高亮与定位）。
- 轻量编辑（<= 512KB）：进入全文编辑（Monaco），支持 Ctrl/⌘+S 保存；基于内容指纹（digest）检测冲突并提示刷新。
- 批注：选区/行级批注，分组列表、编辑/删除，一键回跳到原位置；在 Markdown 预览中可悬浮锚定批注。
- 实时同步：保存文件后 ≤1s 内 UI 必然纠正。读取默认优先走 WebSocket（WS），发生传输/能力类错误在短窗内自动回退 HTTP；服务端广播 `file.changed`/`tree.changed`/`annotations.*` 驱动缓存失效与视图更新。
- 生成拼接（Stitch）：基于批注按模板（如 `concise`）拼接上下文，支持复制到剪贴板，便于投喂到对话式 AI。

安装与运行（推荐）
- 零安装直接运行：
  - 在你的项目目录执行：`npx ai-loom`
  - 首次执行会自动拉取与本机平台匹配的预编译二进制；随后浏览器会自动打开。
- 全局安装：
  - `npm i -g ai-loom` 后运行：`ai-loom --root .`
- 常用参数（透传到后端 `ailoom-server`）：
  - `--root <path>` 指定工作目录（仅能访问此子树）
  - `--db <path>` 或 `--db-path <path>` 指定数据库位置
  - `--port <number>` 指定端口；`--no-open` 禁止自动打开浏览器
  - 仅开发用：`--no-static`（仅启用 API，配合前端 Vite Dev 使用）

快速上手
1) 在目标项目根目录运行 `npx ai-loom`。
2) 浏览器打开后：
   - 左侧选择文件 → 右侧查看内容；大文件自动分页，Markdown 支持全文预览。
   - 点击“进入编辑”可对小文件（≤ 512KB）进行全文编辑，按 Ctrl/⌘+S 保存。
   - 拖选代码或在 Markdown 预览中选中片段，输入批注并保存；在“批注”面板中按文件分组查看、跳转与编辑。
   - 需要把上下文带回 AI 对话？在“批注”面板点击“生成并复制”即可一键拼接并复制。

与 AI 编码协作（如 Vibe Coding）
- 适配 AI 编码流程：在“原文件位置”留下批注，携带行范围与上下文。
- 更高效的往返：从批注中复制片段/路径回到对话即可，无需反复解释“哪个文件第几行”；AI 更容易精确定位并按意图修改。
- 实用场景：标记“需改动/需解释/潜在风险/接口对不齐”等位置，作为下一轮迭代的待办清单。

命令与本地开发（可选）
- 一键同源预览（构建前端后由后端托管）：`just serve`
- 开发热更新：
  - 单终端联动：`just dev-all`（同时启动后端热重载 + 前端 Vite Dev，Ctrl+C 一键退出）
  - 分终端：终端A `just server-dev PORT=63000`；终端B `just web-dev VITE_API_BASE=http://127.0.0.1:63000`
- 仅后端：`just server-run` 或 `ROOT=. WEB_DIST=packages/web/dist just server-run`
- 前端：`just web-install`、`just web-build`（仅在需要产出静态资源时使用）、`just web-dev VITE_API_BASE=http://127.0.0.1:<port>`
- 更多开发与发布流程、编码规范请见 CONTRIBUTING.md

WebSocket 行为与调试
- 默认“读取优先 WS”：读取类调用（树/文件/批注列表）优先走 WS；出现传输/能力类错误在短窗内回退 REST。写入多数走 REST；如需验证保存经 WS，可临时开启 `VITE_WS_WRITE=1`。
- 文件监听（可选）：设置 `AILOOM_FSWATCH_ENABLED=1` 开启后端本地文件监听，实时推送 `file.changed`/`tree.changed`。
- 调试面板：设置 `VITE_WS_DEBUG=1` 打开右下角 WS 面板；`VITE_WS_DEBUG_ROUTE=1` 显示每次调用的 WS/REST 路由决策。
- 详见：`docs/guide/ws-overview.md`（推荐通读）与 `docs/specs/ws/client.md`

API（二次集成）
- 本地服务提供 `/api/*`，适合二次集成或脚本：
  - 目录树：`GET /api/tree?dir=.` → `DirEntry[]`
  - 文件分页：`GET /api/file?path=...&startLine=1&maxLines=2000` → `FileChunk`
  - 文件全文：`GET /api/file/full?path=...`（有大小上限）
  - 保存文件：`PUT /api/file`（`{ path, content, baseDigest? }`，409 表示冲突）
  - 批注 CRUD/导入/导出/校验：`/api/annotations*`、`POST /api/annotations/verify`
  - 拼接生成：`POST /api/stitch?templateId=concise&maxChars=4000`
- 详细契约、错误码与示例：`docs/guide/api.md`

隐私与安全
- 服务仅绑定本机 `127.0.0.1`，启动时回显 `AILOOM_PORT=<port>`。
- 文件访问被限制在 `--root` 子树；遵循 `.gitignore` 与可选 `.ailoomignore`。
- 数据库存放路径可通过 `--db`/`--db-path` 指定；工作区隔离基于“最近 .git 目录或 root 路径”。

仓库结构（概览）
- `packages/rust/ailoom-server`：Axum 服务，静态托管前端并提供 `/api/*`。
- `packages/rust/crates/*`：领域库：`ailoom-core`（类型与错误）、`ailoom-fs`（受根目录沙箱的文件读写，支持忽略与原子写）、`ailoom-store`（SQLite 持久化）、`ailoom-stitch`（批注拼接）。
- `packages/web`：React + Vite 前端（Tailwind v4 + shadcn/ui + Monaco）。
- `docs/`：架构、WS、API 与前端规范等文档。

常见问题
- 未自动打开浏览器：查看终端输出 `AILOOM_PORT=<port>`，手动打开 `http://127.0.0.1:<port>`。
- 提示越权：确保访问的路径在 `--root` 指定的目录之下。
- 大文件被截断：为保护性能与内存，超限文件会被分页或限制全文预览；小文件可进入全文编辑。
- 保存冲突：提示 `CONFLICT` 时表示文件已被外部修改，请先刷新内容再保存。

更多
- 使用说明与本地开发：CONTRIBUTING.md
- 详细架构与技术说明：`docs/guide/`（架构/WS/API/数据/前端/存储/安全等）

License
- MIT（参见 `packages/npm/ai-loom/package.json`）
