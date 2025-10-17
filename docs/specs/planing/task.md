# 执行任务清单（仅保留未完成摘要）

本文件不再维护已实现的分解与细节，统一迁移至 SSoT：
- 架构/API/数据/前端/存储/安全：../../guide/

未完成（按优先级，摘要）：

P0
- MCP Provider（list/get/stitch，仅 127.0.0.1）
- FileChunk camelCase 对齐；/api/file/full 体积兜底；错误码统一

P1
- 前端：统一 Toast；主题切换与记忆；文件树虚拟滚动；仅键盘可达性
- 快速打开（⌘/Ctrl+P）与全局搜索（⌘/Ctrl+Shift+F）（需后端 list/search）
- 小文件编辑：外部变更检测与提示

P2
- Git 未提交文件筛选 API（可选）
- Windows 深入验证；Rust 集成测试；前端关键路径单测
- （可选）Tauri 桌面发布

备注：详细实现以 SSoT 为准，本清单只作待办索引。
