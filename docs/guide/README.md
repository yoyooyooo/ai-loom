# ai-loom 指南（SSoT）

本目录为 ai-loom 的单一事实源（Single Source of Truth, SSoT）。内容以“已实现”为基准，兼顾近期要对齐的规范，指导后续迭代与评审。

包含：
- 架构与目录：见 `architecture.md`
- API 契约：见 `api.md`
- 数据模型（Annotation 等）：见 `data-model.md`
- 文件系统与阈值：见 `fs-and-limits.md`
- Stitch 拼接与预算：见 `stitching.md`
- 前端结构与流程：见 `frontend.md`
- 存储层与迁移：见 `storage.md`
- CLI 分发与运行：见 `cli.md`
- 安全与配置：见 `security.md`

常用索引
- 错误码与前端提示映射：见 `api.md` 尾部小节

快速开始（开发联调）
- 启动：用户本地执行 `just server-dev`（后端热重载 + 前端 Vite Dev）。
- 分终端：`just server-dev` + 另起终端 `just web-dev VITE_API_BASE=http://127.0.0.1:<port>`。
- 仅后端：`ROOT=. WEB_DIST=packages/web/dist just server-run`。
- 仅前端：`just web-install`、`just web-dev`。

注意
- 本指南强制遵循命名与目录规范（参见 docs/frontend-architecture.md）。
- 文档标注“实现差异”的位置说明当前实现与规范仍有出入，后续以本 SSoT 为裁剪方向。
