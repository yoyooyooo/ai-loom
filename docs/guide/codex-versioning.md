# Codex 版本固定与校验

为避免协议不一致，Codex CLI 与 Rust 协议 crate 必须始终指向同一上游 Tag。本指南说明如何固定版本、如何校验以及升级流程。

## 版本来源

- CLI：`packages/rust/ailoom-server/src/services/codex/app_server.rs`
  - 默认固定为 `@openai/codex@0.53.0`。
  - 支持通过环境变量 `CODEX_VERSION` 覆盖，例如 `CODEX_VERSION=0.53.0 just server-dev`。
- Rust 依赖：`packages/rust/ailoom-server/Cargo.toml`
  - `codex-protocol`、`codex-app-server-protocol` 使用 git 依赖，`rev` 指向 `rust-v<version>` Tag 对应的 commit。

## 校验脚本

脚本：`scripts/check-codex-version.sh`

用法：

```bash
# 使用 app_server.rs 中的版本（默认 0.53.0）进行校验
./scripts/check-codex-version.sh

# 或显式指定 npm 版本
./scripts/check-codex-version.sh 0.53.0
```

脚本会执行以下校验：

1. 解析 `app_server.rs` 中的 npm 版本（或命令行参数）。
2. 检查 Cargo.toml 中 codex 相关 crate 的 `rev` 是否一致。
3. 通过 `git ls-remote https://github.com/openai/codex.git refs/tags/rust-v<version>` 获取官方 Tag 对应的 commit。
4. 若 `rev` 与 Tag commit 不一致则报错并返回非零退出码。

建议在 CI 中直接执行：

```bash
./scripts/check-codex-version.sh && cargo check -p ailoom-server
```

## 升级流程

1. 确认上游已发布目标版本（例如 `0.53.0`，Tag 名 `rust-v0.53.0`）。
2. 更新 `app_server.rs`：
   ```diff
- let version = std::env::var("CODEX_VERSION").unwrap_or_else(|_| "0.50.0".into());
+ let version = std::env::var("CODEX_VERSION").unwrap_or_else(|_| "0.53.0".into());
   ```
3. 更新 Cargo.toml：
   ```diff
- codex-protocol = { git = "https://github.com/openai/codex.git", package = "codex-protocol", rev = "b4123b7b1db22a3c0a8b133a23c7b30a477d7b65" }
+ codex-protocol = { git = "https://github.com/openai/codex.git", package = "codex-protocol", rev = "ca80bc4902b7ca49112907152e8ed0879eaa0b78" }
   ```
   同步更新 `codex-app-server-protocol`。
4. 运行 `./scripts/check-codex-version.sh 0.53.0` 确认一致。
5. 运行 `cargo update -p codex-protocol -p codex-app-server-protocol` 并提交更新后的 `Cargo.lock`。
6. 回归 `cargo check -p ailoom-server`、`pnpm --dir packages/web build`。

## 常见问题

- **脚本提示无法解析版本** → 检查 `app_server.rs` 是否仍包含目标版本字面量，或命令行是否传入参数。
- **Tag 未找到** → 上游尚未发布对应 Rust Tag，或 Tag 名与 npm 版本不一致。可通过 GitHub Releases 再次确认。
- **运行时仍拉取旧版本** → 确认部署环境是否设置了 `CODEX_VERSION` 环境变量；该变量优先级高于源码中的默认值。

## 参考

- 上游仓库：<https://github.com/openai/codex>
- 相关文件：
- `packages/rust/ailoom-server/src/services/codex/app_server.rs`
- `packages/rust/ailoom-server/Cargo.toml`
- `scripts/check-codex-version.sh`
- `Justfile` 中的 `codex-codegen`（更新协议类型时配合执行）
