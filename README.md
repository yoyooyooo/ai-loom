- 一键构建并启动
  - just serve
- 单独启动后端（默认托管 packages/web/dist）
  - just server-run
  - 如需临时覆盖路径：ROOT=. WEB_DIST=packages/web/dist just server-run
- API 便捷调试
  - just api-tree PORT=63944 DIR=.
  - just api-file PORT=63944 PATH=README.md START=1 MAX=2000
- 前端
  - just web-install
  - just web-build
  - just web-dev VITE_API_BASE=http://127.0.0.1:PORT
  
- 热更新开发（前后端）
  - 需要安装：cargo install cargo-watch
  - DB 存放在当前仓库：`.ailoom/ailoom.db`
  - 终端A：just server-dev PORT=63000（后端热重载 + 项目内 DB）
  - 终端B：just web-dev VITE_API_BASE=http://127.0.0.1:63000
  - 或运行：just dev（当前终端跑后端，另起一个终端跑前端）

- 发布 / 打包
  - 构建后端 Release + 前端产物并打包：`just publish`
  - 生成：`release/ailoom-<os>-<arch>` 目录与同名 `.tgz`
  - 运行：
    - 解压或进入目录，执行 `./run.sh`（可通过 `PORT=63000 ./run.sh` 指定端口）
    - 生产默认使用用户目录 DB（`~/ailoom/ailoom.db`）; 如需改为项目内 DB，可手动编辑 `run.sh`，添加 `--db-path "$DIR/.ailoom/ailoom.db"`

- NPM 包（元包 + 平台二进制子包）
  - 元包：`packages/npm/ai-loom`（包含 `bin/ai-loom.js` 与 `web/` 静态资源）
  - 平台子包：示例 `packages/npm/server-darwin-arm64`（仅包含 `bin/ailoom-server` 二进制；包名：`@ai-loom/server-darwin-arm64`）
  - 打包：`just npm-pack`（会生成两份 .tgz：`ai-loom-<v>.tgz` 与 `ai-loom-server-darwin-arm64-<v>.tgz`）
  - 发布：`just npm-publish`（需先登录 npm，并按需扩展更多平台子包）
  - 运行（安装后）：`npx ai-loom` 或 `npm i -g ai-loom && ai-loom`

更多参与与发布细节，请参见 `CONTRIBUTING.md`。
