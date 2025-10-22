# Tasks: 条件化省略说明（批注复制）

**Input**: Design documents from `/specs/001-conditional-omission-note/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Rust 单测建议覆盖关键路径；前端以手动验收为主（模板已提供 quickstart）。

**Organization**: 任务按用户故事分组，确保每个故事可独立实现与验收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: 任务归属用户故事（US1、US2、US3）
- 描述内包含精确文件路径

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 对齐现有设计文档与接口说明

- [X] T001 [P] 审阅规范与计划以锁定验收口径：`/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/spec.md`、`/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/plan.md`
- [X] T002 [P] 对齐合约描述与变更点：`/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/contracts/stitch.openapi.yaml`
- [ ] T003 建立本地构建校验基线（fmt/clippy）：`packages/rust/crates/ailoom-stitch/`、`packages/rust/ailoom-server/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 为“按需添加说明”做必要的文本生成结构性改造

- [X] T004 重构生成流程以便首行可选：在 `packages/rust/crates/ailoom-stitch/src/lib.rs` 的 `generate_prompt` 中改为先累计 `body`，最后按需在顶部拼接说明
- [X] T005 提供省略检测工具函数：在 `packages/rust/crates/ailoom-stitch/src/lib.rs` 增加 `fn has_omission_marker(s: &str) -> bool`，匹配 `"<<<OMITTED ~"`
- [X] T006 在 `generate_prompt` 中聚合 `omitted_any` 标志：遍历每个 `snippet` 后更新 `omitted_any |= has_omission_marker(snippet)`（文件：`packages/rust/crates/ailoom-stitch/src/lib.rs`）

**Checkpoint**: 具备在末尾阶段一次性决定是否插入头部说明的能力

---

## Phase 3: User Story 1 - 含省略时自动添加说明 (Priority: P1) 🎯 MVP

**Goal**: 若任一片段发生省略（CHARS 或 LINES），复制内容顶部仅添加一行固定中文说明，并与正文间保留一个空行

**Independent Test**: 构造含省略的样本，复制结果应首行含说明，且仅一次；不依赖其他故事完成

### Implementation for User Story 1

- [X] T007 [US1] 在 `generate_prompt` 内实现条件化说明（concise）：当 `omitted_any` 为真，首行加入 “<<<OMITTED ~N CHARS>>>” 版本说明；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`
- [X] T008 [US1] 在 `generate_prompt` 内实现条件化说明（detailed）：当 `omitted_any` 为真，首行加入 “<<<OMITTED ~N LINES>>>” 版本说明；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`
- [X] T009 [P] [US1] 单测：字符省略时应插入说明（concise）；添加到 `packages/rust/crates/ailoom-stitch/src/lib.rs` 的 `mod tests` 中
- [X] T010 [P] [US1] 单测：行省略时应插入说明（detailed）；添加到 `packages/rust/crates/ailoom-stitch/src/lib.rs` 的 `mod tests` 中
- [X] T011 [US1] 校验统计字段不受影响（`used/truncated/chars`）；必要时在 `packages/rust/crates/ailoom-stitch/src/lib.rs` 修正与断言

**Checkpoint**: 含省略样本首行说明正确出现，且仅一次

---

## Phase 4: User Story 2 - 无省略时不添加说明 (Priority: P1)

**Goal**: 当片段未发生省略时，不添加说明，且不引入多余空行

**Independent Test**: 构造无省略样本，复制结果首行即正文，无说明与冗余空行；不依赖其他故事

### Implementation for User Story 2

- [X] T012 [US2] 单测：无省略（concise）不应插入说明且无额外空行；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`
- [X] T013 [P] [US2] 单测：无省略（detailed）不应插入说明且无额外空行；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`
- [ ] T014 [US2] 修正逻辑以避免空行误插（若测试失败），实现于 `packages/rust/crates/ailoom-stitch/src/lib.rs`
- [X] T015 [P] [US2] 单测：多处省略时说明仅出现一次；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`

**Checkpoint**: 无省略样本无说明、无冗余空行；多处省略也只出现一条说明

---

## Phase 5: User Story 3 - 文案与格式一致性 (Priority: P2)

**Goal**: 说明文案与系统保持完全一致，说明与正文之间恰好一个空行；各复制入口表现一致

**Independent Test**: 在不同入口触发复制，含/不含省略两类样本均满足文案与格式要求

### Implementation for User Story 3

- [X] T016 [US3] 提取文案为常量：在 `packages/rust/crates/ailoom-stitch/src/lib.rs` 定义 `HEADER_CHARS`、`HEADER_LINES`，与既有中文说明完全一致
- [X] T017 [P] [US3] 单测：校验说明文案完全一致且与正文之间仅一个空行；路径：`packages/rust/crates/ailoom-stitch/src/lib.rs`
- [X] T018 [US3] 走查前端复制入口未追加头部文本：`packages/web/src/features/explorer/components/annotation-panel.tsx`（仅读取校验，若无问题则不改动）

**Checkpoint**: 多入口体验一致；文案与格式达到规范

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: 文档与质量保障

- [ ] T019 [P] 更新验收指引：补充/确认 quickstart 步骤与截图：`/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/quickstart.md`
- [ ] T020 [P] 对齐合约描述中的“按需出现说明”措辞：`/Users/yoyo/Documents/code/personal/ai-loom/specs/001-conditional-omission-note/contracts/stitch.openapi.yaml`
- [ ] T021 运行格式与静态检查：`packages/rust`（`cargo fmt && cargo clippy -W warnings`）
- [ ] T022 复核 docs 与注释避免实现细节泄漏到规格层（全局走查）

---

## Dependencies & Execution Order

### Phase Dependencies

- Setup → Foundational → User Stories（US1/US2 可并行，US3 建议在 US1 完成后进行文案与格式收束）→ Polish

### User Story Dependencies

- US1（P1）：独立于其他故事；完成后即可交付 MVP
- US2（P1）：独立于其他故事；与 US1 可并行
- US3（P2）：主要做一致性与走查；可在 US1/US2 基础上并行进行

### Parallel Opportunities

- 标记为 [P] 的单测与文档任务可并行推进
- US1 与 US2 可由不同成员并行实现与验证

---

## Parallel Example: User Story 1

```text
并行启动以下任务：
- T009 [P] [US1] 单测：字符省略时应插入说明（concise）
- T010 [P] [US1] 单测：行省略时应插入说明（detailed）
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 + Phase 2
2. 实施 US1（含单测）并独立验收
3. 若通过，即可作为 MVP 交付/演示

### Incremental Delivery

1. US1 完成后，US2 并行推进，确保无省略时不加说明
2. 随后进行 US3，统一文案常量与入口一致性走查
3. 最终进行 Polish：对齐文档、格式与质量门禁
