# Tauri 桌面端初步方案（替代/补充 npx 启动形态）

> 目标：将当前“npx 本地开发 + 浏览器访问”的形态，补充一条“桌面端（Tauri）”启动路径。优先保留现有前后端逻辑与目录结构，尽量以“壳 + 适配”的方式实现“零/低后端心智成本”的桌面体验。

## 背景与动机

- 现状：
  - 启动方式以 CLI（Node）为主，启动 Rust 后端（Axum）+ 静态托管前端（Vite 构建产物）。
  - 交互侧已聚焦“文件浏览 + 只读滑选 + 批注 + Stitch 复制”。
- 痛点：
  - 浏览器形态对“本地路径/系统整合”能力有限（窗口/托盘/文件选择器/剪贴板/多实例）。
  - 用户期待“一次安装，双击可用”的体验；npx 的前置环境（Node/pnpm）在非前端用户机器上存在门槛。
- 目标：
  - 桌面端“即装即用/双击可用”，与浏览器 UI 保持一致；开发体验不变（可继续 `pnpm dev`）。
  - 迁移风险可控：保留现有 REST 面向前端的契约，逐步下沉到 Tauri Command 直调 Rust crates。

## 架构路线（两阶段）

- 路线 A（快速稳定，优先落地）：Server-Embedded
  - 思路：Tauri 只是“外壳”。前端仍走 HTTP 调 Axum，Axum 以子进程/子线程内嵌的方式在本机随机端口监听；WebView 直接访问 `http://127.0.0.1:<port>`。
  - 优点：无需重写前端 API；风险最小；与浏览器一致。
  - 缺点：多一层本地 HTTP；端口/进程管理要稳妥（生命周期、异常退出、日志）。

- 路线 B（逐步收敛，提升整合）：Direct-Invoke
  - 思路：将 `/api/*` 对应逻辑，改为 Tauri Command 直调 crates：`ailoom-fs/read_file_*`、`ailoom-store/*`、`ailoom-stitch/*`。前端通过 `@tauri-apps/api` 调用，无需本地 HTTP。
  - 优点：更少的开销、更简单的部署（无需监听端口/CORS）；权限与路径控制集中在 Tauri。
  - 缺点：需要前端 API 客户端适配一层（从 fetch → invoke），迁移量随接口数量增加。

> 推荐路径：A 先落地，B 渐进式迁移（优先高频/对性能敏感的接口）。

## 与现有仓库的关系

- Rust Workspace：保持 `ailoom-core/fs/store/stitch/server` 多 crate 分层；Tauri 壳新增 `packages/desktop`（或 `apps/desktop`）。
- 前端：继续 `packages/web`；Tauri Dev 指向 Vite Dev Server，Tauri Build 指向 `packages/web/dist`。
- CLI：短期保留（开发/服务器环境仍可用）；桌面端作为“用户优先”的分发渠道。

## 目录建议

```
packages/
  web/            # 现有前端
  rust/
    ailoom-server
    crates/
      ailoom-core
      ailoom-fs
      ailoom-store
      ailoom-stitch
  desktop/        # 新增：Tauri（Rust + tauri.conf.json）
```

## 实施计划

### P0：最小可用（Server-Embedded 模式）
- 目标：双击运行，WebView 打开 UI；功能等价浏览器形态。
- 事项：
  - Tauri 壳：初始化（稳定版 Tauri 1.x），配置 `devPath` 指向 `pnpm -C packages/web dev`，`buildDist` 指向 `packages/web/dist`。
  - Axum 嵌入：
    - 方案 1（推荐）：以子线程启动 `ailoom-server`（抽出 `run_server(args)`），监听 `127.0.0.1:0`，将端口注入前端（环境或 Tauri state）。
    - 方案 2：以子进程启动 `ailoom-server`，注意进程生命周期与日志回收。
  - 前端：保持现有 `fetch('/api/*')`；`VITE_API_BASE` 指向 `http://127.0.0.1:<port>`。
  - DB/路径：默认 `~/ailoom/ailoom.db` → 回退 `<root>/.ailoom/ailoom.db`；提供目录选择器设置 root。
- 验收：
  - macOS/Windows/Linux 可运行；全量功能可用；退出时 Axum 正常释放。

### P1：直调 crates（Direct-Invoke 模式，按接口渐进）
- 目标：去除本地 HTTP 与端口依赖，提高整合与安全。
- 事项：
  - 在 `packages/desktop` 暴露 Tauri Commands：`list_dir`、`read_file_*`、`write_file`（带 digest）、`list/insert/update/delete annotations`、`stitch_generate` 等。
  - 前端 API 客户端增加 `platformClient` 抽象：Tauri 环境用 `invoke()`；浏览器/CLI 环境仍用 `fetch()`；`client.ts` 保持调用面不变。
  - 权限：Tauri `fs` scope 限制在 `--root`；Clipboard/文件对话框/托盘等用 Tauri API。
- 验收：
  - 浏览→注解→生成 全流程直调；不再依赖本地 HTTP。

### P2：分发与更新
- 打包：DMG/Exe/MSI/AppImage；代码签名与 macOS 公证；体积控制（复用现有 crates，裁剪未用语言 worker）。
- 自动更新（可选）：Tauri Updater（需自建更新服务/发布通道）。
- 上线：提供“桌面端”和“CLI+浏览器”双分发，文档标注适用场景。

## 风险与回避

- 资源占用：Server-Embedded 同时占用 WebView + 本地 HTTP；随着 Direct-Invoke 推进可消减。
- 兼容性：Windows 路径/权限/CRLF 需专项验证；剪贴板/文件选择器在三平台行为差异。
- 安全：Direct-Invoke 模式下，所有文件/DB/剪贴板等需通过 Tauri 权限与白名单控制；拒绝任意路径访问。

## 开发者体验（DX）

- Dev：`pnpm -C packages/web dev` + `cargo tauri dev`
- Build：`pnpm -C packages/web build` → `cargo tauri build`
- 仍保留 `just serve` 以支持浏览器形态调试；桌面端问题通过 Tauri DevTools 与 Rust 日志联调。

## 与现有代码的映射

- 保持多 crate 分层：`ailoom-store/fs/stitch` 直接作为 Tauri Commands 的实现；`ailoom-server` 对 CLI/浏览器与 Server-Embedded 仍有价值。
- 迁移顺序：优先高频接口直调（tree/file/annotations/stitch），其余保留 REST，逐步替换；迁移完成后移除 Axum 对桌面端的依赖。

---

> TL;DR：先用 Tauri 做“外壳 + Axum 进程/线程”，0 迁移成本跑起来；随后按优先级用 Tauri Commands 直调 crates，把 HTTP 退场，最终形成“CLI+浏览器”和“桌面端”双分发，兼顾开发者与普通用户。


## 并行开发与冲突规避（重要）

目标：在同一分支上让两个并行会话分别推进“npx/浏览器（REST）”与“Tauri（桌面）”，通过一次性“共同基线”与清晰的文件边界，避免相互踩踏与频繁冲突。

### 共同基线（一次性变更，功能等价，不引入 Tauri 专属逻辑）
- 后端（ailoom-server）
  - 抽象可嵌入启动：将 `main.rs` 中组装 Axum 的逻辑提炼为库函数（新增 `lib.rs`）：
    - `pub struct ServerArgs { root: PathBuf, web_dist: PathBuf, db_path: Option<PathBuf> }`
    - `pub struct ServerHandle { pub port: u16, /* 内部包含优雅关闭句柄 */ }`
    - `pub async fn start_server(args: ServerArgs) -> anyhow::Result<ServerHandle>`
    - CLI 入口 `main.rs` 仅解析参数并调用上述函数；继续输出 `AILOOM_PORT=...` 以供 CLI/npx 监听与自动打开。
  - CORS：为 REST 层加入宽松 CORS（P0 阶段允许 Any），以兼容 Tauri Dev (`http://localhost:*`) 与 Prod (`tauri://localhost`) 的跨源 `fetch`。
  - 监听策略：仍绑定 `127.0.0.1:0`（随机端口），不改变现有行为。
- 前端（web）
  - API Base 运行时注入（不改调用面）：统一从以下优先级读取 `API_BASE`（仅在 `client.ts` 一处实现）：
    1) `window.__AILOOM_API_BASE`（全局变量）
    2) URL 查询参数 `?apiBase=...`
    3) `import.meta.env.VITE_API_BASE`
    4) 默认空串（同源）
  - 功能不变；npx/浏览器形态照常依赖同源或 `VITE_API_BASE`；Tauri 形态仅需在加载前注入即可。

基线合入后，即可在同一分支并行推进两条路线；后续 Tauri 专属变更尽量放在新增文件/目录内。

### 文件边界与所有权（为并行迭代划线）
- 仅 Tauri 新增（默认无人共享，避免冲突）
  - `packages/desktop/**`（Tauri 工程目录，含 `src-tauri`、`tauri.conf.json` 等）
  - `src-tauri/src/main.rs`：应用生命周期中调用 `ailoom-server::start_server()`（子线程）并注入 `apiBase`；注册优雅关闭。
  - 不在 Tauri 工程内改动 `ailoom-server` 源码，避免跨目录耦合。
- Web 平台抽象（渐进式，建议新增为主）
  - 新增：`packages/web/src/lib/api/platform/http.ts`（封装 fetch）
  - 新增：`packages/web/src/lib/api/platform/tauri.ts`（封装 `@tauri-apps/api` 的 `invoke`）
  - 新增：`packages/web/src/lib/api/platform/index.ts`（运行时选择实现，依据 `window.__TAURI__` 或显式开关）
  - `client.ts` 作为稳定门面：仅在一次性基线中调整 `API_BASE` 获取；后续 Tauri 相关调用通过新增的 `platform/*`，尽量不再直接改 `client.ts`。
- 服务器侧（共享但改动冻结）
  - `packages/rust/ailoom-server/src/main.rs`：仅保留 CLI 解析与打印端口；完成基线后避免再改此文件。
  - `packages/rust/ailoom-server/src/lib.rs`：承载 `start_server()` 及路由/中间件装配；后续如无必要避免结构性调整。

### PR/任务切片建议（同一分支、可并行）
- PR A（共同基线，优先合并）
  - ailoom-server：抽 `lib.rs` + `start_server(ServerArgs) -> ServerHandle`
  - ailoom-server：在路由层加入宽松 CORS（P0）
  - web：`API_BASE` 运行时注入优先级（全局变量/URL/env/默认）
- PR B（Tauri 壳新增，新增文件为主，低冲突）
  - 新增 `packages/desktop/**`；Tauri Dev 指向 Vite Dev，Build 指向 `packages/web/dist`
  - 应用启动：起 `start_server()`，拿到端口；通过 `window.eval('window.__AILOOM_API_BASE=...')` 或 URL `?apiBase=` 注入
  - 应用退出：调用 `ServerHandle` 的优雅关闭
- PR C（可选，平台抽象，新增为主）
  - 新增 `platform/*`，`client.ts` 只做转发；为 P1 Direct-Invoke 做地基
- PR D（可选，Direct-Invoke 渐进迁移）
  - 在 Tauri 内增加 Commands：`list_dir/read_file_*/write_file/annotations/stitch`，前端在 Tauri 环境走 `invoke()`；接口按频度逐步替换 REST

### 锁文件与依赖策略
- 将“引入 Tauri 依赖”的提交与“Web/Server 改动”分开，降低锁文件冲突概率：
  - Cargo：先落地 `ailoom-server` 的 `lib` 抽取（不新增依赖），再新增 Tauri 工程（独立 Cargo.lock）
  - Web：不引入 ESLint/Prettier 等全局性依赖，仅新增平台层文件，避免 `pnpm-lock.yaml` 的大规模变更

### CI 与本地验证（双形态同时保障）
- 浏览器/npx 形态：`pnpm -C packages/web build`、`cargo run -p ailoom-server -- --root . --web-dist packages/web/dist`
- Tauri Dev：`pnpm -C packages/web dev` + `cargo tauri dev`（由 Tauri 启动内嵌 server 并注入 `apiBase`）
- Tauri Build：`pnpm -C packages/web build` → `cargo tauri build`
- 建议在 CI 中并行执行两条流水线，保证任一修改不破坏另一形态

### 安全与收敛
- P0：CORS 允许 Any 仅限于本地桌面开发与快速落地；进入 P1 后可收紧到 `tauri://localhost` 与 `http(s)://127.0.0.1:*`/`localhost:*`
- P1：Direct-Invoke 后，桌面端可去掉本地 HTTP 与 CORS；权限由 Tauri Scope 管控

### 给协作方/LLM Agents 的约定
- 若修改以下文件，请先声明“独占”：
  - `packages/web/src/lib/api/client.ts`
  - `packages/rust/ailoom-server/src/main.rs`（基线完成后避免修改）
- Tauri 相关实现尽量在新增文件中进行，不直接修改现有 REST 端点；前端改动以平台层新增为主
- 提交说明中标注：属于 PR A/B/C/D 的哪一类，便于审阅者套用对应验收清单


## 基线变更清单（Checklist）

- 目标：一次性完成“共同基线”，随后可在同一分支开两个新会话并行推进 npx（REST）与 Tauri（桌面）。
- 范围：仅涉及后端启动方式抽象、CORS 放通、前端 API_BASE 运行时注入。不新增 Tauri 工程、不引入新依赖。

### Session A（后端基线：ailoom-server）
- 抽象可嵌入启动
  - 新增 `packages/rust/ailoom-server/src/lib.rs`：导出
    - `ServerArgs { root, web_dist, db_path }`
    - `ServerHandle { port, /* 内部持有优雅关闭句柄 */ }`
    - `start_server(args: ServerArgs) -> Result<ServerHandle>`
  - 调整 `packages/rust/ailoom-server/src/main.rs`：仅解析 CLI 参数并调用 `start_server`，输出 `AILOOM_PORT=...`。
- 放通 CORS（P0 宽松）
  - 在路由装配处追加 `CorsLayer`，允许任意来源/方法/头；保持监听 `127.0.0.1:0`。
- 验收标准
  - `cargo run -p ailoom-server -- --root . --web-dist packages/web/dist` 正常启动并输出 `AILOOM_PORT=<port>`。
  - 端点响应含 CORS 头；预检 `OPTIONS` 通过；功能与当前 REST 等价。
  - 不改 CLI 行为；不新增依赖；`Cargo.lock` 无大幅变更。

### Session B（前端基线：web）
- API_BASE 运行时注入（不改调用面）
  - 修改 `packages/web/src/lib/api/client.ts`：按优先级获取 `API_BASE`：
    1) `window.__AILOOM_API_BASE`（全局变量）
    2) URL 查询 `?apiBase=...`
    3) `import.meta.env.VITE_API_BASE`
    4) 默认空串（同源）
  - 可在 `packages/web/src/env.d.ts` 补充：
    - `declare global { interface Window { __AILOOM_API_BASE?: string } }`
- 验收标准
  - 无 `__AILOOM_API_BASE` 且无 `?apiBase=` 时行为不变（同源或 `VITE_API_BASE`）。
  - 启动服务后，浏览器用 `http://127.0.0.1:<port>/?apiBase=http://127.0.0.1:<port>` 可正常工作（验证注入路径）。
  - 不改变 `client.ts` 的导出签名；`pnpm -C packages/web build` 通过；`pnpm-lock.yaml` 无大幅变更。

### 共同验收
- npx 启动链路未受影响：`npx ai-loom --root .` 正常打开页面且功能等价。
- 文档已更新（本页“并行开发与冲突规避”与“基线变更清单”章节）。
- 不涉及 Tauri 工程新增；无全局工作流/Justfile 变动；不引入 ESLint/Prettier 等全局依赖。

### 提交边界与命名
- 单 PR 完成上述基线变更，推荐提交信息：
  - `refactor(server): extract start_server to lib.rs`
  - `feat(server): add permissive CORS for desktop dev`
  - `feat(web): runtime API_BASE injection (global/query/env)`
- 变更范围仅限上述文件；避免并发改动：
  - `packages/rust/ailoom-server/src/main.rs`
  - `packages/web/src/lib/api/client.ts`

### 注意事项
- 该基线不要求实现 Tauri 注入，仅需保证注入通道可用（`?apiBase=` 与全局变量读取）。
- CORS 暂时宽松，仅用于 P0；进入 Direct-Invoke 完成后可在桌面端移除 HTTP/CORS。
