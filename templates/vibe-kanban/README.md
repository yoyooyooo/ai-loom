# vibe-starter

最小可用的全栈脚手架模板：Rust(Axum) 后端 + React(Vite) 前端，通过 npx 一键运行，内置 SQLite 与自动迁移。

## 快速体验（npx 一键运行）

```bash
npx vibe-starter
```

- 将自动解压并在系统临时目录运行后端二进制（保证 SQLite 可写），首启自动执行数据库迁移，随后自动打开浏览器。
- 如需自定义端口，可设置 `BACKEND_PORT` 环境变量。

## 本地开发（源码模式）

### 前置依赖
- Rust（stable）
- Node.js（18+）
- cargo-watch（热重载，开发推荐）：
  ```bash
  cargo install cargo-watch
  ```

> 说明：SQLite 无需额外安装，模板会在首次启动时自动创建并迁移数据库；`sqlx-cli` 不是必需，仅在你需要离线校验或手动迁移时再安装。

### 安装与启动
```bash
# 克隆与依赖安装
git clone <your-repo>
cd vibe-starter
npm install
cd frontend && npm install && cd ..

# 一键前后端并行开发
npm run dev
```

默认：
- 后端监听 `127.0.0.1:3333`（可通过 `BACKEND_PORT` 调整）
- 前端开发服务器 `http://localhost:3000`（代理 `/api` 到后端）
- 数据库文件默认为 `sqlite://./vibe-starter.db`，首次启动自动迁移

常用脚本：
```bash
npm run dev            # 前后端并行（vite + cargo watch）
npm run frontend:dev   # 仅前端
npm run backend:dev    # 仅后端（自动迁移）
npm run generate-types # 从 Rust 模型生成 TS 类型（shared/types.ts）
npm run check          # Rust + 前端检查
```

## 本地打包与 CLI 运行（验证 npx 体验）

```bash
# 构建前端与后端，并打包到 npx-cli/dist/<platform>/vibe-starter.zip
npm run build

# 直接运行 CLI（等价 npx 效果）
node npx-cli/bin/cli.js
```

说明：
- 产物 zip 同时包含后端二进制与 `frontend/dist`，服务端可直接托管前端。
- CLI 会在系统临时目录运行，并设置 `DATABASE_URL=sqlite://<tmp>/vibe-starter.db`。

## 目录结构

```
vibe-starter/
├── crates/                    # Rust 后端工作区
│   ├── server/               # HTTP 路由与静态托管
│   ├── db/                   # SQLx 模型与迁移
│   ├── services/             # 业务服务
│   ├── utils/                # 工具库
│   ├── local-deployment/     # 依赖装配与注入
│   └── generate_types/       # TypeScript 类型生成
├── frontend/                 # React 前端（Vite）
├── npx-cli/                  # CLI 分发包
├── shared/                   # 由 ts-rs 生成的 TS 类型
├── .github/workflows/        # CI 配置
├── publish.sh                # 一键发布脚本
└── PUBLISH.md                # 发布指南
```

## 发布

建议先阅读精简版流程：见 [PUBLISH.md](./PUBLISH.md) 的「快速发布 TL;DR」。

## 许可协议

MIT
