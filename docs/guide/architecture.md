# 架构与目录（已实现）

概览
- 后端：Rust/Axum 二进制 `ailoom-server`，静态托管前端并提供 `/api/*`。
- 领域库：多 crate 解耦（core/fs/store/stitch）。server 仅组装路由与调用库能力。
- 前端：React + Vite + Tailwind v4 + shadcn/ui + Monaco（只读/可选全量编辑）。
- 存储：SQLite（WAL、busy_timeout），默认 `~/ailoom/ailoom.db`，失败回退为项目根 `.ailoom/ailoom.db`。
- 分发：`npx ai-loom` 跨平台封装，按平台选择对应二进制子包运行。

工作区结构（关键路径）
- `packages/rust/ailoom-server`：Axum 服务路由与静态资源托管
- `packages/rust/crates/ailoom-core`：类型（DirEntry、FileChunk、Annotation等）
- `packages/rust/crates/ailoom-fs`：根目录沙箱、忽略规则合并、分页读取、二进制探测、原子写与冲突检测
- `packages/rust/crates/ailoom-store`：SQLite 迁移、CRUD、导入/导出合并
- `packages/rust/crates/ailoom-stitch`：模板（concise/detailed）、中间省略、统计
- `packages/web`：前端应用（Vite + React + Tailwind + shadcn/ui）
- `packages/npm/ai-loom`：CLI 入口与平台二进制选择

路由与静态托管
- API：`/api/tree` `/api/file` `/api/file/full` `PUT /api/file` `/api/annotations*` `/api/stitch`
- 静态：默认将 `packages/web/dist` 挂载到 `/`（可通过 `--no-static` 关闭以配合 Vite Dev）
- 绑定：仅 `127.0.0.1`，启动时输出 `AILOOM_PORT=<port>`。

实现差异（对齐方向）
- `/api/file` 返回体字段当前为 snake_case，前端按 camelCase 使用（见 `fs-and-limits.md` 的对齐说明）。

