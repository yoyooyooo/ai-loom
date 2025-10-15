# Rust Workspace（长期结构）

## 目标

- 以多包（多 crate）解耦领域、存储、文件系统、拼接与对外接口，便于后续独立演进与替换实现。
- MVP 仅启用必要子包；其余包先占位（README + Cargo.toml），后续逐步实现。

## 目录布局（Monorepo）

- packages/
  - rust/
    - ailoom-server/（bin）Axum 服务与路由注册、静态托管、进程配置
    - crates/
      - ailoom-core/（lib）核心领域模型与服务接口（无 IO）
      - ailoom-store/（lib）SQLite 适配与仓储实现（sqlx + 迁移）
      - ailoom-fs/（lib）文件树、忽略规则合并、分页读取
      - ailoom-stitch/（lib）模板聚合、预算裁剪与围栏修复
      - ailoom-mcp/（lib）MCP Provider（仅本机、只读）
      - ailoom-engine/（lib，占位）AST/ctags/tree-sitter 摄取（后续）
      - ailoom-fts/（lib，占位）全文索引/搜索封装（后续）
      - ailoom-graph/（lib，占位）符号图谱与关系（后续）
  - web/（React + Vite + Tailwind + shadcn/ui）
  - cli/（npx 启动器）
  - ts-shared/（可选，前端复用的 types 与 API 客户端）

## 前期独立包（立即拆分）

- ailoom-core：领域模型与接口。无 IO、无全局状态，以便在测试与未来替换实现时保持稳定。
- ailoom-store：SQLite 实现（sqlx）。提供迁移、CRUD、导入合并与分页查询；对外只暴露 trait 实现。
- ailoom-fs：文件系统访问、忽略合并、二进制判定与分页读取；不依赖 server/web。
- ailoom-stitch：模板渲染与预算裁剪；仅依赖 core。
- （可选）ailoom-mcp：如需并行开发，可提前独立，MVP 也可后置。

说明：`ailoom-server` 仅负责组装路由与对接这些库，不承载领域逻辑。

## Workspace 示例（根 Cargo.toml 片段）

```
[workspace]
members = [
  "packages/rust/ailoom-server",
  "packages/rust/crates/ailoom-core",
  "packages/rust/crates/ailoom-store",
  "packages/rust/crates/ailoom-fs",
  "packages/rust/crates/ailoom-stitch",
  "packages/rust/crates/ailoom-mcp",
  # 未来：
  "packages/rust/crates/ailoom-engine",
  "packages/rust/crates/ailoom-fts",
  "packages/rust/crates/ailoom-graph",
]
resolver = "2"
```

## 子包职责与依赖（简表）

- ailoom-core
  - 模型：Annotation、Stats、模板枚举、错误类型
  - 接口：StoreTrait、FsReader、Stitcher
  - 依赖：无（保持纯领域，无 IO）

- ailoom-store
  - 实现：SQLite（sqlx/SQLite），WAL、busy_timeout、连接池
  - 能力：迁移、CRUD、导入/导出合并（去重与冲突策略）、分页查询
  - 依赖：ailoom-core

- ailoom-fs
  - 能力：`/api/tree` 懒加载一层、`.gitignore` + `.ailoomignore` 合并（后者优先）、分页读取、二进制判定
  - 依赖：ailoom-core

- ailoom-stitch
  - 能力：concise/detailed 模板渲染、预算裁剪（maxChars）、围栏修复、统计
  - 依赖：ailoom-core

- ailoom-mcp
  - 能力：`list_contexts`/`get_context`/`stitch`；仅本机、无鉴权（MVP）
  - 依赖：ailoom-core、ailoom-store、ailoom-stitch

- ailoom-server
  - 能力：Axum 路由 `/api/tree` `/api/file` `/api/annotations*` `/api/stitch`、静态托管 web/dist、配置与日志
  - 依赖：ailoom-core、ailoom-store、ailoom-fs、ailoom-stitch、（可选）ailoom-mcp

- 占位包（未来）：ailoom-engine、ailoom-fts、ailoom-graph
  - 暂不启用；预留接口与测试夹具目录

## Feature 约定

- 默认最小：`default = ["stitch", "fs", "store"]`
- 可选：`mcp`、`fts`、`engine`
- server 按 feature 有条件编译对应路由或 Provider

## 前后端接口对齐

- REST 契约：docs/specs/api.md（`/api/file` 分页、`/api/annotations*`、`/api/stitch`）
- MCP 契约：docs/specs/mcp.md（工具参数与返回）
- 阈值与限制：docs/specs/planing/mvp-roadmap.md（默认阈值章节）

## 数据与路径

- DB：`~/ailoom/ailoom.db`（Windows：`%USERPROFILE%\ailoom\ailoom.db`）
- 静态资源：构建后将 `packages/web/dist` 提供给 server 静态目录或内嵌

## 拆分准则（早拆分）

- 边界稳定：抽象在 `core` 定义（struct/enums/traits），不得从 `server/web` 反向引用。
- 依赖方向：`server` 依赖 `lib`，`lib` 间依赖尽量无环；利用 feature 限定可选能力。
- API 颗粒度：优先 trait + DTO，隐藏具体 DB/FS 实现细节。
- 可测试性：每个 crate 自带最小单测（核心路径），`store`/`fs` 提供集成测试夹具。
- 版本与发布：内部 workspace 先不发 crates.io；若未来上游复用，采用 semver 与最小依赖。
