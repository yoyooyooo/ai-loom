# 文件系统与阈值（已实现）

根目录沙箱
- 启动参数 `--root` 指定根目录；所有路径经 `canonicalize()` 校验必须落在根目录内，否则返回 `INVALID_PATH`。

忽略规则
- 目录列表使用 `ignore::WalkBuilder`：默认尊重 `.gitignore`。
- 额外支持 `.ailoomignore`；若存在则合并（优先级更高）。
- 内置硬排除：`.git/`、`node_modules/`。

非文本/二进制检测
- 读取前 64KB 探测，含 `\0` 或非 UTF-8 则视为非文本：返回 `{ error: { code: 'NON_TEXT' } }`（或 415）。

分页读取与阈值（/api/file）
- 文件大小软阈值：`2MB`；硬阈值：`5MB`。
- 读取逻辑：始终进行“按行分页”读取（`startLine/maxLines`）；
  - `truncated=true` 当满足：硬阈值命中 或 软阈值命中且未读到文件末尾。
- 语言：按扩展名粗判 `rust/typescript/javascript/json/markdown/...`，未知回退 `plaintext`。

全文读取与编辑（/api/file/full + PUT /api/file）
- `/api/file/full` 读取全文并返回 `digest`（SHA-256 of content）。超过硬阈值（5MB）将拒绝全量读取，返回 `413` + `{ error:{ code:'OVER_LIMIT' } }`。
- PUT 保存：采用 `baseDigest` 冲突检测；不一致时返回 409 + `currentDigest`。写入采用“写临时文件再重命名”的原子写策略。
- 前端默认仅在小文件（≤512KB）提供“进入编辑”入口；其余场景建议分页查看。

参数默认与上限（服务端）
- `/api/file`：`startLine=1`、`maxLines=2000`、`maxLines<=5000`。

已落地的兜底
- 服务端已对 `/api/file/full` 做硬阈值限制（>5MB 返回 413/OVER_LIMIT），与前端入口限制配合使用。
