# pnpm v9 + workspace + optionalDependencies 在 CI 冻结安装下的锁不一致问题

- 状态：临时规避已落地（publish-meta 阶段按包过滤安装 + 显式 `--no-frozen-lockfile`），严格 frozen 待后续再评估。
- 相关版本：Node 18、pnpm 9.15.9（由根 `package.json: packageManager` 指定，CI 通过 `pnpm/action-setup@v4` 对齐）。
- 影响范围：仅发布流水线的 meta 包构建阶段（`packages/npm/ai-loom` 与 `packages/web`）。

## 现象（CI 报错）

CI 默认开启 `--frozen-lockfile`，在执行按包过滤安装时失败：

```
_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/npm/ai-loom/package.json

Failure reason:
specifiers in the lockfile ({"commander":"^12.1.0","detect-libc":"^2.0.2","@types/node":"^20.12.12","tsup":"^8.1.0"})
  don't match specs in package.json ({
    "@types/node":"^20.12.12","tsup":"^8.1.0","detect-libc":"^2.0.2","commander":"^12.1.0",
    "@ai-loom/server-darwin-arm64":"0.0.22","@ai-loom/server-darwin-x64":"0.0.22",
    "@ai-loom/server-linux-arm64-gnu":"0.0.22","@ai-loom/server-linux-arm64-musl":"0.0.22",
    "@ai-loom/server-linux-x64-gnu":"0.0.22","@ai-loom/server-linux-x64-musl":"0.0.22",
    "@ai-loom/server-win32-x64-msvc":"0.0.22"
  })
```

## 背景

- monorepo（pnpm workspace），根锁单一（不维护子包锁）。
- 元包 `ai-loom`：包含 CLI（tsup 打包）与静态前端（拷贝 web/dist），并通过 `optionalDependencies` 依赖平台二进制子包（`@ai-loom/server-*`）。
- 发布流水线：矩阵先发布平台二进制子包；随后在 `publish-meta` 任务中构建并发布 `ai-loom` 元包。
- 目标：
  - 发布前始终构建 CLI，保证 `dist/cli.js` 包含新增 `--watch`。
  - 不在 CI 启动 dev server；仅按需构建。
  - 最小化安装范围，避免 workspace 其他包干扰。

## 根因分析

- pnpm v9 在 workspace 下会对每个 importer（子包）做“依赖键集合”严格校验。
- `optionalDependencies` 受平台 gating 影响，写锁/读锁时 importer 的 `specifiers` 集合可能不包含所有平台键；而 `package.json` 里是全量键。
- 在单根锁 + 过滤安装 + CI 默认 frozen 的组合下，安装 `packages/npm/ai-loom` 时，pnpm 会拿根锁里该 importer 的 `specifiers` 与其 `package.json` 做比较，集合不等（缺少若干 `@ai-loom/server-*` 键）→ 直接失败。
- 注意：即便可选依赖的版本号全部一致，这个问题仍会发生，因为比较的是“键集合”，不是“版本是否一致”。

## 方案对比

- A. 子包独立锁（`.npmrc: shared-workspace-lockfile=false`）+ 子包目录下 `--frozen-lockfile`
  - 优点：严格 frozen，跨平台稳定，不受根锁其他 importer 影响。
  - 缺点：需要维护子包锁（你不希望维护）。

- B. 单根锁 + 过滤安装 + 非 frozen（仅限发布构建阶段）【采纳】
  - 做法：在 `publish-meta` 任务中对 `packages/web` 与 `packages/npm/ai-loom` 的安装命令显式加 `--no-frozen-lockfile`，并使用 `--filter` 限定安装范围；随后构建并发布。
  - 优点：变更最小；不引入子包锁；不过多影响现有结构；确保 CLI 与 Web 构建产物随发布产出。
  - 缺点：发布阶段的安装不再严格 frozen，但范围已最小化（仅两个包）。

- C. CI 先执行一次 `pnpm -w install --lockfile-only`，再 frozen
  - 优点：可将锁的 importer 与当前平台对齐，减少集合不一致概率。
  - 缺点：锁会被平台污染（形态随平台变化），且我们不会在 CI 提交锁；仍可能与本地有差异。

## 当前决策（2025-10）

- 采用方案 B：在 `.github/workflows/release-npm.yml` 的 `publish-meta` 任务中：
  - Web：`pnpm i --prefer-offline --filter ./packages/web --no-frozen-lockfile` → `pnpm -C packages/web build` → 拷贝 dist 到 `packages/npm/ai-loom/web/`。
  - Meta：`pnpm i --prefer-offline --filter ./packages/npm/ai-loom --no-frozen-lockfile` → `pnpm -C packages/npm/ai-loom build`。
- 其他保持：
  - 平台矩阵 job 名显示 `server-...` 全名（易读）。
  - 元包 `package.json` 保持 `bin: dist/cli.js`、`scripts.build: tsup`，确保 `--watch` 选项随构建产出。
  - `scripts/bump-npm-version.mjs` 统一版本并重建 `optionalDependencies`；`scripts/npm-bump-auto.sh` 仅写根锁（`pnpm -w install --lockfile-only`），不使用 corepack。

## 验证

- 本地（不启动服务）：
  - `pnpm -v` → 9.15.9
  - `pnpm -w install --lockfile-only` → 成功
  - `pnpm i --prefer-offline --filter ./packages/web && pnpm -C packages/web build` → 成功
  - `pnpm i --prefer-offline --filter ./packages/npm/ai-loom && pnpm -C packages/npm/ai-loom build` → 成功
  - `rg -n -- '--watch' packages/npm/ai-loom/dist/cli.js` → 能命中（确认选项已打包）

## 后续与建议

- 若未来要严格 frozen：回到方案 A（子包独立锁 + 子包目录下 `--frozen-lockfile`）。
- 持续关注 pnpm 在 v9+ 的 workspace + optionalDependencies + frozen 行为是否提供更优配置或修复（例如 importer 集合校验策略）。
- 仍建议：发布版本变更时先执行一次“只写根锁”（`pnpm -w install --lockfile-only`），保证锁与 `package.json` 同步，但在 meta 构建阶段不强制 frozen。

