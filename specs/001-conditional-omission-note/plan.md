# Implementation Plan: 条件化省略说明（批注复制）

**Branch**: `001-conditional-omission-note` | **Date**: 2025-10-22 | **Spec**: /Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/spec.md
**Input**: Feature specification from `/specs/001-conditional-omission-note/spec.md`

## Summary

- 用户意图：仅在生成的批注 prompt 内实际发生“片段省略”时，才在复制内容顶部附加说明行；否则不附加。
- 技术思路：在后端 `ailoom-stitch` 的 `generate_prompt` 中统计本次拼接是否出现过省略标记（`<<<OMITTED ~... CHARS/LINES>>>`）。仅当出现时输出说明行；未出现则不输出。前端复制逻辑保持不变。

## Technical Context

**Language/Version**: TypeScript (Web, React + Vite)、Rust 1.75+（后端 crate）  
**Primary Dependencies**: Web：React、TanStack Query、shadcn/ui；Server：`ailoom-stitch`（内部 crate，被 `ailoom-server` 使用）  
**Storage**: N/A（无数据模型变更）  
**Testing**: Rust 单测（`ailoom-stitch` 片段省略与说明插入）；Web 手动验收（含/不含省略两类）  
**Target Platform**: 桌面浏览器 + 本地后端服务  
**Project Type**: Web 前端 + Rust 服务（单仓多包）  
**Performance Goals**: 复制交互“无明显等待”（≤0.2s 主观）  
**Constraints**: 不改变前端/后端公开接口行为语义（仅输出内容文本差异）；遵循前端/后端既有目录与命名规范  
**Scale/Scope**: 小改动（单 crate 文本生成逻辑 + 验收用途的前端操作路径）

## Constitution Check

*GATE: 必须通过后再进入 Phase 0，Phase 1 完成后复核一次。*

- 目录/命名：遵循 `packages/rust/crates/*`、`packages/web/src/*` 与 kebab-case/PascalCase 约束（PASS）。
- 架构边界：仅改动 `ailoom-stitch` 文本生成逻辑，不新增项目/依赖（PASS）。
- 前端规范：不引入新组件库；路径别名使用 `@`（前端不改或仅用于手动验收）（PASS）。
- WS/HTTP：仅影响复制文本内容，不改通信策略（PASS）。
- 质量门禁：Rust `cargo fmt`/`clippy -W warnings` 需通过；前端 Prettier（PASS by plan）。

结论：GATES PASS（无例外申请）。

Post-Design Re-check：本次设计不引入新依赖/结构变更；接口不变；遵循命名/路径/WS 策略（PASS）。

## Project Structure

### Documentation (this feature)

```text
specs/001-conditional-omission-note/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
└── contracts/           # Phase 1 输出（OpenAPI 片段）
```

### Source Code (repository root)

```text
packages/
├── rust/
│   ├── ailoom-server/
│   │   └── src/routes/stitch.rs           # 保持不变（返回 StitchResult）
│   └── crates/
│       └── ailoom-stitch/
│           └── src/lib.rs                 # 本次改动：条件化输出说明行
└── web/
    └── src/
        └── features/explorer/components/annotation-panel.tsx  # 生成并复制入口（用于手动验收）
```

**Structure Decision**: 单仓多包结构；仅在 `ailoom-stitch` 内做最小变更，避免前端分散判断。

## Complexity Tracking

（空）本次不需要违反章程或新增复杂度。

## Phase 0: Outline & Research

### Unknowns → Research Tasks

- 省略标记的完整集合：是否仅有 `CHARS` 与 `LINES` 两种？（研究代码确认）
- 判定“发生省略”的稳健策略：基于标记字符串匹配 vs. 基于裁剪结果对比（研究与权衡）。

### Findings (research.md 将收敛为决策)

- 决策倾向：以“是否出现 `<<<OMITTED ~` 前缀”作为发生省略的判断，覆盖 CHARS/LINES 两类，可靠且无需额外状态。
- 替代方案：对比 `snippet` 与 `raw` 判断是否变短，但仍需防御末尾换行整理等无害改写；故优先使用显式标记匹配。

输出：/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/research.md

## Phase 1: Design & Contracts

### data-model.md（非持久化，仅文档模型）

- Entity: Copied Prompt（复制文本）
  - Header（可选说明行）：仅当任一片段含 `OMITTED` 标记时出现
  - Body：拼接后的批注列表文本
- Entity: Omission Marker
  - 形式：`<<<OMITTED ~N CHARS>>>` 或 `<<<OMITTED ~N LINES>>>`
  - 语义：表示片段中部被省略的字符/行数

### contracts/

- `/api/stitch`（POST）保持不变：
  - Request：`{ templateId: string, maxChars: number, annotationIds?: string[] }`
  - Response：`{ prompt: string, stats: { total:number, used:number, truncated:boolean, chars:number } }`
  - 说明：`prompt` 开头的“说明行”从“总是存在”改为“按需出现”。

### quickstart.md（验收指引）

- 含省略用例：选择长片段，生成并复制，确认首行有说明行；无省略用例：短片段，确认首行即正文且无多余空行。

### Agent Context 更新

- 运行：`.specify/scripts/bash/update-agent-context.sh codex`（仅登记“条件化说明行”变更点，不引入新技术）。

## Phase 2: Planning (Tasks Outline)

- Rust：在 `ailoom-stitch` 内实现条件化说明输出（新增布尔 `omitted_any` 聚合或基于标记检测）。
- Rust：为 `collapse_middle_*` 与 `generate_prompt` 编写/补充单测，覆盖含/不含省略、CHARS/LINES、多片段仅 1 次说明。
- Web：走查 `annotation-panel.tsx` 入口，无需改动；执行手动验收用例。
- 文档：更新 quickstart 与 contracts 说明。
