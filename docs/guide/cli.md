# CLI 分发与运行

入口包
- `npx ai-loom`（`packages/npm/ai-loom`）按平台选择二进制子包并启动 `ailoom-server`。
- 支持 `--version/-v`：输出包版本；若为 `0.0.0` 尝试读取 git tag/sha 补充。

平台选择
- macOS：`@ai-loom/server-darwin-{arm64|x64}`
- Linux：`@ai-loom/server-linux-{x64|arm64}-{gnu|musl}`（libc 族通过 detect-libc 判断）
- Windows：`@ai-loom/server-win32-x64-msvc`

可覆写
- `AILOOM_SERVER_BIN`：指定自定义二进制路径（优先）。

默认参数
- 未显式传入时：
  - `--root` 默认 `process.cwd()`
  - `--web-dist` 默认指向包内 `web` 目录（内置构建产物）

传参透传
- CLI 其余参数透传到 `ailoom-server`（详见 `server --help`）。

