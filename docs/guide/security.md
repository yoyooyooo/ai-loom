# 安全与配置

进程与监听
- 仅绑定回环地址 `127.0.0.1`。
- 启动打印 `AILOOM_PORT=<port>`，便于前端通过环境变量联调。

CORS
- API 路由附加宽松 CORS（Any），用于 Vite 本地联调；静态资源走 `/` 无需 CORS。

路径与沙箱
- 通过 `canonicalize()` 校验请求路径必须在 `--root` 指定的根目录下。
- 非文本/二进制文件拒绝预览（返回 `NON_TEXT`）。

写入安全
- 保存采用原子写（同目录临时文件后 `rename`）；
- 基于 `digest` 的冲突检测，返回 409 避免外部覆盖。

忽略与体积
- 合并 `.gitignore` 与 `.ailoomignore`（后者优先级高），避免扫描噪音与大目录压力。
- 分页读取 + 软/硬阈值控制；必要时对大文件禁用全量入口。

日志
- 使用 `tracing` + `tower_http::TraceLayer`，默认 `INFO`；控制台输出，未落盘。

