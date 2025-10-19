# AI Coding 支持路线图（建议稿）

本文档给出在现有实现基础上，面向“辅助 AI Coding”的演进路线。定位是本地优先（仅 127.0.0.1）、安全可控、可迭代分层，不引入外部黑盒 SaaS 依赖。在实现上尽量复用/扩展当前的 Axum 服务、SQLite 存储、前端 React 架构与批注/拼接（Stitch）能力。

相关已实现能力与 SSoT 请先阅读：
- 架构与目录：../../guide/architecture.md
- 前端架构：../../frontend-architecture.md、../../guide/frontend.md
- API 与数据模型：../../guide/api.md、../../guide/data-model.md
- 存储与限制：../../guide/storage.md、../../guide/fs-and-limits.md
- Stitch：../../guide/stitching.md

关联的未实现规格（建议配合推进）：
- 上下文中枢：../context-hub.md
- MCP 集成：../mcp.md
- 检索与预算：../retrieval-and-budget.md
- 符号索引与代码图谱：../symbol-index-and-graph.md

## 一、目标与原则

- 目标：让模型“理解你的仓库”，并在最小风险下高效提出改动建议、生成补丁、协助验证与回滚。
- 原则：
  - 本地沙箱与限额优先；不绕过现有根目录沙箱与忽略规则。
  - 逐步引入索引与检索，先可用后增强；先薄能力再厚算法。
  - 明确的人在环：所有更改以补丁形式预览与确认，可回滚。
  - 与现有批注/拼接复用：把“AI 调用的上下文包”视为 Stitch 的一个 profile。

## 二、能力地图（分层）

1) 上下文采集与归一
- Ingest：批注、文件片段、文件全量、Git 元数据、路由/API 等。
- Normalize：统一成 ContextItem（类型/来源/范围/权重）。
- Store/Index：SQLite 表 +（可选）FTS5；与现有 annotations/workspaces 对齐。

2) 检索与预算
- 查询：按路径/符号/标签/相似度（可后续）检索上下文。
- 预算：按 Profile 配额（行/字节/token 估算）打包 Pack，超限裁剪。

3) 生成与变更
- 计划（plan）：把自然语言需求转为“修改计划 + 文件列表 + 风险点”。
- 补丁（patch）：在服务器侧生成最小 diff（行级/Hunk），并执行冲突校验。
- 校验（verify）：静态检查、格式化（Prettier/rustfmt）与基本构建探测（可选）。

4) 集成方式
- REST：新增只读/只写少量端点；沿用 JSON 类型定义。
- MCP：提供 list_contexts/get_context/stitch/plan/apply_patch 等工具（先只读，逐步放开写）。
- IDE：VS Code 插件（后续，复用本地端口与 MCP）。

5) 安全与治理
- 路径沙箱、忽略规则、体积上限、速率限制；敏感文件 denylist。
- 补丁前置审查，所有写操作必须经过“显式确认”。

6) 评估与反馈
- 本地只留匿名指标：补丁大小、是否回滚、失败原因。
- 失败路径沉淀为“提示词模板/纠错指南”，供后续 Stitch 调优。

## 三、里程碑（M4–M9）

### M4：MCP Provider（本机只读）
- 工具：
  - `ai-loom.list_contexts(kind='annotation'|'file'|'api', limit, offset)`
  - `ai-loom.get_context(id)`
  - `ai-loom.stitch(templateId, annotationIds?, maxChars?)`
- 约束：仅 127.0.0.1；响应体积上限；错误可读化。
- 前端：在 Explorer 中曝光“复制 MCP 工具示例”与“调试返回”。

### M5：快速检索与全局搜索
- 后端：
  - `/api/search`：基于 ripgrep（优先）或 SQLite FTS5 的快速文本检索，返回匹配片段（path, line, preview）。
  - `/api/quick-open`：仅文件名/路径模糊匹配。
- 前端：
  - 命令面板与搜索面板；搜索结果可直接高亮跳转文件/行。
- 存储：可选 FTS5 索引，按 workspace_id 隔离；落库策略可先“即时查询不入库”。

### M6：符号索引与代码图谱（最小可用）
- 后端：
  - 新表 `items`（符号卡片）与 `edges`（关系），首批支持 TS/TSX 与 Rust 的文件级/导出级索引。
  - 构建任务：按需、增量（保存后异步更新）。
  - API：`/api/symbols?path=...`、`/api/symbol-refs?id=...`。
- 前端：
  - 文件内结构大纲、跳转定义/引用（最小实现，可回退到文件级别）。
- 检索：将“符号卡片”作为 ContextItem 参与 Stitch 预算。

### M7：上下文中枢与 Pack Builder
- 实现 ../context-hub.md 概述的 Ingest → Normalize → Retrieval/Pack 流程。
- Profile：`coding.minimal`、`coding.full` 等；按类目配额（文件片段、注释、符号卡片）。
- 预算：token 估算与裁剪；拼接前评估与可视化（预览即将发送的上下文）。

### M8：补丁工具链（Plan → Patch → Verify）
- REST：
  - `POST /api/plan`：输入自然语言需求 + 选中文件/目录，返回修改计划（受沙箱/忽略规则约束）。
  - `POST /api/patch/dry-run`：根据计划与模型输出生成统一 diff（.patch），只做校验与预览。
  - `POST /api/patch/apply`：应用补丁，原子写入，冲突/越界保护；可选自动格式化。
- 前端：
  - Diff 预览与分段勾选；失败回滚提示；与批注互链（从补丁创建批注、从批注生成计划）。
- 验证：
  - Web：Prettier 检查（存在就用，失败只提示不阻断）。
  - Rust：rustfmt 检查（同上）；可选 `cargo check` 的浅探测（开关控制）。

### M9：IDE/Agent 深度集成
- VS Code 插件：
  - 连接本地服务器/MCP；在编辑器内唤起“生成计划/应用补丁/查看上下文”。
  - 复用现有 REST/MCP，无需额外后端。
- Agent Loop（可选）：
  - 简化版“思考-行动-反思”：限制步数与可用工具；每步产生短计划与可回溯日志。

## 四、API 与存储扩展（草案）

- 新 API（REST）：
  - `GET /api/search?q=&path=&limit=`
  - `GET /api/quick-open?q=&limit=`
  - `GET /api/symbols?path=`、`GET /api/symbol-refs?id=`
  - `POST /api/plan`、`POST /api/patch/dry-run`、`POST /api/patch/apply`
- 新表（SQLite）：
  - `items(id, workspace_id, kind, path, name, range, meta, updated_at)`
  - `edges(id, workspace_id, src_id, dst_id, kind)`
  - `search_index`（可选 FTS5）
  - `patch_proposals(id, workspace_id, title, diff, created_at, status)`

## 五、前端改动概览

- features/explorer：
  - 增加 search/quick-open 面板与快捷键；搜索结果与编辑器联动。
  - 增加 diff 预览与补丁应用对话框；批注面板与补丁互链。
  - 将“生成上下文包（Profile）”放入 Stitch 面板，预览 token 预算。

## 六、边界与非目标

- 不内置商用 LLM，推理侧由上层调用者决定（本项目只负责上下文、计划/补丁协议与验证工具）。
- 不引入长驻守护与高权限；保持即开即用、可关闭的本地进程模型。

## 七、验证与发布建议

- 每个里程碑附带最小端到端验证路径与演示脚本（见各 PR 的“验证步骤”）。
- 先以 CLI/REST 可用为准，再补前端易用性；避免“前端先行但能力缺失”。

—— 本文为建议路线，落地时以 SSoT 与现有实现为准，优先小步快跑与可回滚的更改。
