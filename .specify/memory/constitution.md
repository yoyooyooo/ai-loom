<!--
Sync Impact Report
- Version change: (template) → 1.0.0
- Modified principles: N/A（首次落地）
- Added sections: Core Principles（5项）；附加约束与标准；开发工作流与质量门禁；Governance
- Removed sections: 无
- Templates requiring updates:
  - ✅ 已核对 .specify/templates/plan-template.md（Constitution Check 按本章程执行）
  - ✅ 已核对 .specify/templates/spec-template.md（与本章程不冲突）
  - ✅ 已核对 .specify/templates/tasks-template.md（与本章程不冲突）
  - ⚠ 未发现 .specify/templates/commands/* 目录，暂无可对齐项
- Deferred TODOs: 无
-->

# AI Loom（Ailoom） Constitution

## Core Principles

### 1) 安全与沙箱边界（非可选）
AI Loom 的一切能力必须在受控、本机、安全的边界内运行。

- 服务仅绑定 `127.0.0.1`；所有文件访问严格限制在 `--root` 子树内（越界一律 `INVALID_PATH`）。
- 目录树遵循 `.gitignore` 并合并 `.ailoomignore`；硬排除 `.git/`、`node_modules/`。
- 读取前 64KB 做二进制探测，非文本拒绝预览（`NON_TEXT`/HTTP 415）。
- 分页读取强制启用；全文读取/编辑受硬阈值 5MB 限制，超限返回 413/`OVER_LIMIT`。
- 写入采用 `baseDigest` 冲突检测与原子写；冲突返回 409/`CONFLICT`。
- 数据库默认 `~/ailoom/ailoom.db`，失败回退项目根 `.ailoom/ailoom.db`；同一实例按工作区隔离。

Rationale：保护隐私与工作区安全，防止越权访问与资源耗尽。

### 2) 读取优先 WS，可靠自愈
读取类调用优先走 WebSocket，在短窗熔断内出现传输/能力类错误才回退 REST；写入默认 REST。

- 读取（树/文件/批注）MUST 优先走 WS；短窗内 WS 错误→自动 REST 回退（可用 `VITE_WS_NO_FALLBACK=1` 禁用以做纯 WS 验证）。
- 写入默认 REST；如需验证保存经 WS，可临时 `VITE_WS_WRITE=1`（`file.save`）。
- 服务端 MUST 广播 `file.changed`、`tree.changed`、`annotations.*` 驱动缓存失效与 UI 同步。
- Hub/Ring/Forwarder/Writer 架构：单写者 send+flush 成功才计 `lastSent`；断线支持 `events.resume(after/tail)` 增量恢复；`tree.changed` 为低优先，压力下可丢弃以保障 `file.changed/annotations.*`。
- 调试与验证：`VITE_WS_DEBUG=1` 打开面板；`VITE_WS_DEBUG_ROUTE=1` 查看 WS/REST 路由；`AILOOM_FSWATCH_ENABLED=1` 开启本地监听；必要时 `AILOOM_WS_EAGER_SAVE_ECHO=1` 兜底“保存即见”。
- 体验目标：保存后 ≤1s 内 UI 必然纠正（弱网/后台 Tab 亦应自愈）。

Rationale：提升响应性与一致性，在复杂网络环境下保持可恢复与可观测。

### 3) 前端架构与命名规范（强制）
统一的工程与命名保证可维护性与可协作性。

- 技术栈：Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui（CLI 安装）+ Monaco。
- 路径别名：`@` → `src`；文件/目录一律 `kebab-case`；组件导出用 `PascalCase`。
- 文件类型：仅出现 JSX 时使用 `.tsx`，否则 `.ts`；工具/常量/类型文件命名统一为 `utils.ts`/`constants.ts`/`types.ts`。
- Barrel：仅允许在 feature 目录边界 `index.ts` 聚合；禁止深层 barrel 以避免循环依赖。
- React Query：Query Key MUST 按约定命名 `['tree', root, dir]`、`['file', path, startLine, maxLines]`、`['annotations']`；写后精确 `invalidateQueries` 或直改缓存。
- shadcn/ui：一律使用 CLI 安装；遵循 `packages/web/components.json`；Tailwind v4 通过 `@tailwindcss/vite` 接入，并在 `src/styles/globals.css` 定义令牌以启用 `bg-muted` 等语义色。
- 格式化：Prettier（单引号、无分号、printWidth=100）。

Rationale：约束先行，降低风格漂移与踩坑成本。

### 4) 开发流程与工具链（约束）
遵循统一的开发命令与评审要求，避免环境耦合与不必要构建。

- 热更新：`just dev-all` 或分终端 `just server-dev` + `just web-dev`。开发阶段不构建静态产物；仅在需要产出静态资源时使用 `just web-build`/`just serve`。
- 后端：`cargo build -p ailoom-server`、`cargo test -p <crate>`；建议 `cargo fmt && cargo clippy -W warnings`。
- 前端：`just web-install`、`just web-dev`；Web 测试暂未配置，复杂逻辑建议配套 Vitest/RTL 基础用例。
- 提交与 PR：推荐 Conventional Commits；PR 必须包含变更概述、动机与方案、验证步骤（含 just/cargo/pnpm 命令）、必要截图或日志、关联 Issue。
- 契约：API 行为与错误码必须与 `docs/guide/api.md` 对齐（`INVALID_PATH/NON_TEXT/OVER_LIMIT/CONFLICT/INTERNAL`）。

Rationale：统一开发体验与最小惊讶原则，降低协作成本。

### 5) 简洁优先与可调试性
保持实现简单、边界清晰，并确保一线可观测与排障路径。

- 先做简单可行的方案（YAGNI），避免过度设计。
- 对外接口优先文本/JSON I/O，便于脚本化与排障。
- 提供足够观测：WS 调试面板、服务端 ring/broadcast 统计与错误日志；必要时用 `AILOOM_WS_EAGER_SAVE_ECHO=1` 提升开发期可见度。
- 文档即约束：新增/修改能力必须同步更新 `docs/guide` 与本章程对应条目。

Rationale：在小步快跑中保证问题可见、定位迅速。

## 附加约束与标准

**性能与阈值**
- `/api/file` 默认 `startLine=1`、`maxLines=2000`，上限 `maxLines<=5000`。
- 全文读取超过 5MB 一律拒绝（413/`OVER_LIMIT`）；编辑入口默认仅对 ≤512KB 文件开放。
- `tree.changed` 为低优先，环容量紧张时可丢弃以保障关键事件。

**部署与分发**
- 推荐通过 `npx ai-loom` 启动；需指定可访问的 `--root`。仅本机访问；生产/公网部署不在当前范围。

**二次集成**
- `/api/*` 契约详见 `docs/guide/api.md`；错误码到前端提示的映射需保持一致。

## 开发工作流与质量门禁

**门禁（Constitution Check）**
- 任何计划与实现必须通过“原则 1–5”逐项核对：沙箱/WS 策略/前端规范/流程与工具链/可调试性。
- 违反任一原则时，必须在计划（plan.md）的 Complexity Tracking 表中记录原因与替代方案取舍。

**评审清单（关键核对）**
- 命名与目录（kebab-case、PascalCase、别名 `@`）。
- React Query Key 与失效策略是否对齐约定；写后精确失效或直改。
- WS 路由选择与回退策略是否符合“读取优先 WS”。
- 错误码/HTTP 状态是否与 `docs/guide/api.md` 一致。
- Rust：`cargo fmt`、`clippy -W warnings` 通过；Web：Prettier 格式化通过。

## Governance
本章程对齐仓库内 `docs/guide/*` 的技术约束，是工程实践的最高优先级文档。

**修订流程**
- 通过 PR 修改本文件；PR 中必须说明动机、影响面、迁移/对齐计划与验证步骤。
- 合并前需完成“门禁核对”，并在必要时同步更新 `docs/guide/*` 与相关模板。

**版本语义**
- MAJOR：有向后不兼容的治理/原则删除或重定义。
- MINOR：新增原则/章节，或对指导性内容作实质性扩展。
- PATCH：措辞澄清、错别字、非语义改进。

**合规审查**
- 所有 PR/Code Review MUST 检查与本章程 1–5 原则及“附加约束”的一致性。
- 如需例外，必须在 plan.md 的 Complexity Tracking 表中记录并获评审认可。

**Version**: 1.0.0 | **Ratified**: 2025-10-22 | **Last Amended**: 2025-10-22
