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

---

## 合理性评审（结论与补充建议）

- 结论：当前“单根锁 + 按包过滤安装 + 仅在 `publish-meta` 阶段显式关闭 frozen”的做法是合理的、变更最小且可控的权衡。它绕开了 pnpm v9 在 workspace importer 上对 `specifiers` 键集合的严格比对，同时将“非 frozen”的影响面限制在两个必要的构建包（`packages/web` 与 `packages/npm/ai-loom`）。
- 可接受的原因：
  - 发布标签创建前，通过 `pnpm -w install --lockfile-only` 已确保根锁与源码一致；
  - `publish-meta` 中的非 frozen 安装仅为“读锁并构建”，不会向仓库回写锁，也不会扩大安装范围；
  - 使用 `--filter` + `--prefer-offline` 降低解析抖动与网络变量，对可复现性影响有限。
- 潜在风险与边界：
  - 在极端情况下，如果某些依赖的 semver 范围已变更且本地锁未包含所需解析，非 frozen 安装可能触发新的解析并试图更新锁（CI 不提交，产物仍以解析结果为准）。降低该风险的关键是：在发版前始终执行一次根目录的“只写锁”。
  - 由于问题根因是“importer 的键集合不一致”，即便可选依赖版本号相同也会失败，因此只要维持单根锁 + 过滤安装 + frozen，就仍会复现；这印证了绕过 frozen 的必要性，直到 pnpm 行为有改进。
- 建议的附加保护（非必须）：
  - 在 `publish-meta` 任务的两个按包安装步骤后，增加一次只读校验：`git diff --quiet -- pnpm-lock.yaml || echo "[warn] install 过程中根锁发生变化（CI 不提交，仅提示）"`，用于早期发现潜在的解析漂移。
  - 持续在 bump 流程中校验 pnpm 版本与 `packageManager` 一致（脚本已覆盖），并固定 Node 主版本（Action 已固定为 18）。
  - 若后续需要完全可复现性（frozen）与平台可选依赖同时满足，优先切换到“子包独立锁”（方案 A），并在子包目录下使用 `--frozen-lockfile` 进行安装与构建。
