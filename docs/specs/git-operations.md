# Git 操作技术选型与“未提交文件筛选”方案

> 目标：在本项目内形成一致的 Git 操作技术基线，并立即支持“快速筛选未提交文件（uncommitted files）”。其他 Git 需求后续补充到本规范。

## 背景

- 我们需要在本地工作区内完成若干 Git 能力，且优先满足“只列出未提交文件，而不是所有文件”的诉求。
- 参考项目 vibe‑kanban 的实践：将工作区可变操作交由 Git CLI 执行，图谱/只读查询可用 libgit2；该模式在跨平台与 sparse‑checkout 语义上更稳健。

## 技术选型（结论优先）

- 首选 Git CLI 作为工作区可变操作的执行层（add/commit/merge/rebase/checkout/worktree 等）。
  - 理由：
    - 更安全的默认保护（不会轻易覆盖未提交变更与未跟踪文件）。
    - 原生支持 sparse‑checkout，避免语义不一致导致 diff/暂存错误。
    - 跨平台可靠性更高（WSL/Windows/macOS 等环境一致性更好）。
- 可选 libgit2 用于只读图谱或必要的引用/网络操作；但不直接操纵工作区的可变状态。
- 依赖要求：节点机器必须可用 `git` 可执行程序（`git --version` 可用）。

## 概念与语义

- 未提交文件（uncommitted files）包括：
  - Tracked 文件的 staged 或 unstaged 变更（任一列非空）。
  - Untracked 文件（且不被忽略）。
- 以 `git status --porcelain` 输出为准（稳定、机器可读）。

## 命令行方案（立即可用）

用于在终端快速筛选未提交文件（与服务实现语义一致）：

- 方案 A（解析 porcelain，兼容重命名行的 `old -> new` 语法）

```bash
REPO=.

git -C "$REPO" -c core.quotepath=false status --porcelain=v1 \
  | sed -E 's/^.. //; s/^\?\? //' \
  | sed -E 's/.* -> //' \
  | awk 'NF'
```

- 方案 B（简单快速，修改/删除/未跟踪，默认忽略 `.gitignore` 中的规则）

```bash
REPO=.

git -C "$REPO" ls-files -m -d -o --exclude-standard
```

- 指定子路径/文件：

```bash
git -C "$REPO" status --porcelain -- path/to/dir another/file.ts
# 或
git -C "$REPO" ls-files -m -d -o --exclude-standard -- path/to/dir
```

> 建议统一加 `-c core.quotepath=false` 以避免路径被转义；使用 `--` 分隔 pathspec，防止选项冲突。

## 服务端建议实现（Rust）

短期内无需引入 libgit2，即可用 `std::process::Command` 封装一层：

```rust
use std::path::Path;
use std::process::Command;

/// 返回未提交文件路径列表（tracked 变更 + untracked，已应用忽略规则）。
pub fn list_uncommitted_files(repo: &Path, paths: Option<&[&str]>) -> anyhow::Result<Vec<String>> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo)
        .arg("-c").arg("core.quotepath=false")
        .arg("status").arg("--porcelain=v1");
    if let Some(p) = paths { cmd.arg("--"); for s in p { cmd.arg(s); } }

    let out = cmd.output()?;
    if !out.status.success() { anyhow::bail!(String::from_utf8_lossy(&out.stderr).to_string()); }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();
    for line in stdout.lines() {
        let l = line.trim_end();
        if l.is_empty() { continue; }
        // ?? path（untracked）
        if let Some(rest) = l.strip_prefix("?? ") { files.push(rest.to_string()); continue; }
        // 规范行：两列状态+空格+路径 或 `old -> new`
        if l.len() >= 3 {
            let (_, tail) = l.split_at(2); // 跳过XY
            let pathspec = tail.trim_start();
            let path = if let Some((_, newp)) = pathspec.split_once(" -> ") { newp } else { pathspec };
            if !path.is_empty() { files.push(path.to_string()); }
        }
    }
    Ok(files)
}
```

- 若需要对比基线分支并保留重命名检测，可扩展为：
  - 使用临时索引 `GIT_INDEX_FILE` + `git read-tree HEAD` + `git add -A`，再执行 `git diff --cached -M --name-status <base>` 解析，这一做法对重命名敏感且稳定。

## API 设计（可选）

- `GET /api/git/uncommitted?root=<abs_or_workspace>&paths=a,b,c` → `200 application/json`

```json
{
  "root": "/abs/path/to/repo",
  "count": 3,
  "files": ["src/a.ts", "src/b.ts", "README.md"]
}
```

- 行为：
  - `paths` 可选：逗号分隔 pathspec，未提供则对仓库根；
  - 返回仅包含未提交文件；
  - 禁止越权：`root` 必须在工作区白名单内（参见安全规范）。

## 边界与注意事项

- 进行中操作：rebase/merge/revert/cherry-pick 等状态下，某些命令会失败或输出不完整；调用方需根据需要提前检测。
- 忽略与子模块：`status/ls-files` 默认遵从 `.gitignore`，子模块如需展开需额外处理。
- 大仓/性能：必要时使用 `--porcelain -z`（NUL 分隔）降低解析开销；或限定路径范围。
- 环境要求：确保 `git` 可执行程序在 PATH 中可用；否则需提示安装或降级处理。

## Roadmap（后续）

- 增加文件状态枚举输出（A/M/D/R/??）与 JSON 格式接口。
- 加入对基线分支的差异视图（含重命名检测与路径过滤）。
- 前端支持“仅显示未提交文件”的切换与路径过滤控件。
- CLI/Justfile 增加 `just uncommitted [paths...]` 快捷命令。

