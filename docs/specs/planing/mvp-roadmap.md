# MVP 路线图（迁移说明）

当前状态（基于实现）：
- M0–M2 已完成：文件浏览/分页、批注 CRUD + 导入导出、Stitch 生成与复制、CLI 封装、静态托管。
- M3 未完成：MCP Provider（本机、只读）。

已实现的规范与细节请参见 SSoT：
- 架构与目录：../../guide/architecture.md
- API 与数据模型：../../guide/api.md、../../guide/data-model.md
- 文件系统与阈值：../../guide/fs-and-limits.md
- 前端流程：../../guide/frontend.md
- Stitch：../../guide/stitching.md
- 存储：../../guide/storage.md
- 安全：../../guide/security.md

剩余事项（摘要）：
- MCP Provider：`list_contexts/get_context/stitch` 工具（仅 127.0.0.1，体积上限）。
- FileChunk 命名对齐 camelCase；/api/file/full 体积兜底限制。
- 文件外部变更检测（保存冲突以外的提示流）。
- 快速打开与全局搜索（可能依赖 `ripgrep` 或 FTS）。
- 文件树/批注列表的虚拟滚动与可达性。
- Git 未提交文件筛选 API（可选）。
- Windows 深入验证；基本集成测试；前端关键路径单测。
-（可选）桌面打包（Tauri）。

说明：后续仅在此文件维护“尚未完成”的概要，所有已实现细节以 SSoT 为准。
