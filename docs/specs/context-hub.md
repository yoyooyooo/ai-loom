# 上下文中枢（Context Hub）

## 1. 定位与目标

- 定位：ai-loom 作为 AI Coding 的“上下文中枢”，统一采集、生成、存储与分发多源上下文（人工批注、项目事实、固定场景任务、代码/接口图谱等），以最小 Token 成本提供高价值上下文。
- 目标：
  - 聚合：统一模型（ContextItem/ContextPack）管理多源上下文。
  - 压缩：通过结构化与摘要化，将“大上下文”压缩为“小提示”。
  - 分发：手动复制导出与 MCP 工具化双通路消费。
  - 实时：监听项目变更，增量更新上下文索引与快照。

## 2. 上下文类型（Kinds）与示例

- `annotation`：人工批注（文件范围、原文、评论）
- `project_fact`：项目事实（技术栈、脚本、配置、端口）
- `task_playbook`：固定场景任务（Runbook/Checklist/模板）
- `code_symbol`：代码符号（函数/类/变量/类型/导出项）
- `api_route`：接口路由（method/path/handler/验证器）
- `config_item`：配置项（来源文件/键/值/影响范围）
- `db_schema`：数据库结构（表/列/索引/外键）
- `change_digest`：变更摘要（commit/PR 摘要、热区）
- `style_guide`：约定与规范（命名/目录/编程规范）

## 3. 消费方式

- 手动：选择 items/packs → Stitcher 生成 Prompt/Markdown/JSON → 复制或导出
- 程序化：MCP Provider 工具集（list/search/get/subscribe），按需拉取

## 4. 组件与数据流

1) Ingestors/Resolvers：从文件系统、配置、Git、AST 解析生成 ContextItem
2) Normalizer：将语言/来源各异的数据归一化为标准 Schema
3) Store/Index：磁盘存储 + 查询索引（SQLite/JSON+索引），维护 item、关系与快照
4) Retrieval & Stitcher：检索、排序、预算分配与拼接输出
5) API（Axum/Rust）与 MCP：对外暴露检索、获取、订阅能力

## 5. Token 预算与拼接策略

- 预算档（Profile）：`minimal`/`concise`/`detailed`，分别控制每类上下文的配额与截断策略
- 优先级：`annotation > api_route > code_symbol > project_fact > task_playbook > others`
- 截断策略：先结构化、再摘要化（可选 LLM/OA 替代），最后按片段截断并保留锚点

## 6. 快照与包（Snapshot/Pack）

- Snapshot：一次拼接结果的不可变快照，可复用/对比/回滚
- ContextPack：可安装/分享的上下文集合（items + 元信息 + 依赖），支持签名校验
