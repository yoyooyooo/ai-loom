# 📦 发布指南

这是一个完整的发布流程指南，说明如何将 vibe-starter 项目发布为 npm 包并支持 `npx` 命令。

## ⚡ 快速发布 TL;DR

```bash
# 1) 拉取主分支最新代码
git checkout main && git pull

# 2) 安装依赖并构建（产物 zip 位于 npx-cli/dist/<platform>/）
npm install && (cd frontend && npm install)
npm run build

# 3) 发布到 npm（主包）
npm login
npm publish

# 4) 验证（推荐使用主包）
npx vibe-starter
```

如需拆分为独立 CLI 包（可选），进入 `npx-cli` 目录后再执行 `npm publish`。

## 🚀 一键发布脚本

使用提供的发布脚本可以自动完成整个发布流程：

```bash
# 运行一键发布脚本
./publish.sh
```

这个脚本将自动执行以下所有步骤。

## 📋 手动发布步骤

如果你想了解详细流程或需要手动操作，请按以下步骤进行：

### 1. 准备工作

```bash
# 确保所有代码都已提交
git status

# 确保在主分支上
git checkout main

# 拉取最新代码
git pull origin main
```

### 2. 运行测试

```bash
# 运行所有测试和检查
npm run check
npm test
npm run lint
```

### 3. 更新版本号

```bash
# 更新 package.json 版本号（选择 patch/minor/major）
npm version patch

# 或者手动编辑 package.json 和 npx-cli/package.json
```

### 4. 构建项目

```bash
# 构建前端和后端
npm run build

# 或者使用等价脚本
bash local-build.sh
```

### 5. 生成类型文件

```bash
# 确保 TypeScript 类型是最新的
npm run generate-types

# 检查类型是否同步
npm run generate-types:check
```

### 6. 发布到 npm

```bash
# 登录到 npm（如果还没有登录）
npm login

# 发布主包
npm publish

# 发布 CLI 包
cd npx-cli
npm publish
cd ..
```

### 7. 创建 Git 标签

```bash
# 创建版本标签
git tag v$(node -p "require('./package.json').version")

# 推送标签
git push origin --tags
```

### 8. 验证发布

```bash
# 验证可以通过 npx 运行（推荐主包）
npx vibe-starter

# 或验证独立 CLI 包（如果单独发布了 npx-cli）
npx vibe-starter-cli

# 验证包信息
npm info vibe-starter
npm info vibe-starter-cli
```

## 🔧 发布配置

### package.json 配置

主包的 `package.json` 需要包含：

```json
{
  "name": "vibe-starter",
  "version": "0.1.0",
  "files": [
    "npx-cli/bin/cli.js",
    "npx-cli/dist/**"
  ],
  "bin": {
    "vibe-starter": "npx-cli/bin/cli.js"
  }
}
```

### CLI 包配置

`npx-cli/package.json` 需要包含：

```json
{
  "name": "vibe-starter-cli",
  "version": "0.1.0",
  "bin": {
    "vibe-starter-cli": "./bin/cli.js"
  },
  "files": [
    "bin/cli.js",
    "dist/**"
  ]
}
```

## 🏗️ 构建说明

### 支持的平台

构建脚本支持以下平台：

- **macOS ARM64** (Apple Silicon: M1/M2/M3)
- **macOS x64** (Intel)
- **Linux x64**
- **Windows x64** (暂未实现)

### 构建产物

构建完成后，产物位于：

```
npx-cli/
├── bin/
│   └── cli.js          # CLI 启动脚本
└── dist/
    ├── macos-arm64/
    │   └── vibe-starter.zip
    ├── macos-x64/
    │   └── vibe-starter.zip
    ├── linux-x64/
    │   └── vibe-starter.zip
    └── windows-x64/
        └── vibe-starter.zip
```

运行时行为说明：

- CLI 会在系统临时目录解压并运行二进制，确保 SQLite 数据库文件具有写权限；
- 运行时自动设置 `DATABASE_URL=sqlite://<tmp>/vibe-starter.db`，服务启动时会自动执行迁移；
- 发行包 zip 同时包含 `frontend/dist`，后端通过 Axum 静态托管并提供 SPA fallback；
- Windows x64 打包尚未在脚本中实现，可按需扩展交叉编译与打包逻辑。

## 🔍 故障排除

### 常见问题

1. **构建失败**
   ```bash
   # 检查 Rust 工具链
   rustup update
   cargo --version
   
   # 检查 Node.js 版本
   node --version
   npm --version
   ```

2. **类型生成失败**
   ```bash
   # 重新生成类型
   rm -rf shared/types.ts
   npm run generate-types
   ```

3. **发布权限错误**
   ```bash
   # 检查 npm 登录状态
   npm whoami
   
   # 重新登录
   npm login
   ```

4. **包名冲突**
   ```bash
   # 检查包名是否已被占用
   npm info vibe-starter
   npm info vibe-starter-cli
   ```

## 📊 发布检查清单

发布前请确认：

- [ ] 所有测试通过
- [ ] 代码已提交并推送
- [ ] 版本号已更新
- [ ] 构建成功
- [ ] TypeScript 类型已生成且最新
- [ ] npm 已登录
- [ ] 包名未被占用
- [ ] README 和文档已更新

## 🔄 自动化发布

### GitHub Actions

项目包含完整的 CI/CD 配置 (`.github/workflows/test.yml`)，可以：

- 自动运行测试
- 检查代码格式
- 构建项目
- 安全审计

### 扩展自动发布

可以扩展 GitHub Actions 来自动发布：

```yaml
# 在 .github/workflows/ 中添加 publish.yml
name: Publish
on:
  push:
    tags:
      - 'v*'
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 📚 相关文档

- [npm 发布指南](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [npx 使用说明](https://docs.npmjs.com/cli/v8/commands/npx)
- [Rust 交叉编译](https://rust-lang.github.io/rustup/cross-compilation.html)
