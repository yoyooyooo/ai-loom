# Feature Specification: Chat Sidebar Layout Refinement

**Feature Branch**: `006-chat-sidebar-refine`  
**Created**: 2025-10-25  
**Status**: Draft  
**Input**: User description: "packages/web/src/components/app-sidebar.tsx 这个 block 是我从 shadcn/ui 下载的一个 sidebar block，我希望整个应用都以此为基底进行整个应用的 UI 优化。 第二栏和第三栏，并非固定的每个顶层大模块都会有。当然现在我们的这两个顶层大模块(chat/explore)是有的，但是现在的这个 Sidebar Demo，我希望仅作用于 Chat 模块。然后第二栏也就是现在渲染了 mails 列表，我们要替换成会话历史列表。 explore 的右侧内容区则直接照搬以前的 然后我们的路由系统，如果有必要的话，也要做对应的调整。"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat 模块三栏体验 (Priority: P1)

当用户点击左侧主导航中的 Chat 模块时，希望在主内容区域内看到会话历史（第二栏）和消息详情（第三栏），以便快速切换会话并继续沟通。

**Why this priority**: Chat 是最常用模块，布局调整直接影响主要业务价值。

**Independent Test**: 仅访问 `/chat`，验证会话列表与消息视图是否同时呈现且可交互。

**Acceptance Scenarios**:

1. **Given** 用户进入 `/chat`，**When** 系统加载历史会话，**Then** 第二栏显示按最新排序的会话列表并高亮当前会话。
2. **Given** 用户在会话列表选择另一条，**When** 点击后，**Then** URL/状态同步到该会话且第三栏显示对应消息记录。

---

### User Story 2 - Explore 模块沿用旧体验 (Priority: P2)

当用户切换到 Explore 模块时，希望右侧内容与旧版本保持一致（文件树+编辑区），只复用新的全局布局，不影响既有操作路径。

**Why this priority**: Explore 是次要但仍高频的模块，必须保留熟悉工作流。

**Independent Test**: 访问 `/explore`，检查文件树、预览/编辑区的交互是否与当前线上行为一致。

**Acceptance Scenarios**:

1. **Given** 用户打开 `/explore`，**When** 展开文件树并选择文件，**Then** 右侧编辑器/预览区正确展示内容且支持原有操作。

---

### User Story 3 - 模块可选多栏扩展 (Priority: P3)

作为产品设计者，希望新的布局允许未来模块自由决定是否呈现第二/第三栏，避免被迫套用三栏结构。

**Why this priority**: 保障架构弹性，减少后续模块接入成本。

**Independent Test**: 创建一个仅使用主内容区的占位模块，验证它在新布局下不展示空白多栏并保持可用。

**Acceptance Scenarios**:

1. **Given** 某模块标记为单栏模式，**When** 用户切换到该模块，**Then** 主内容区独占空间且不存在空白的第二/第三栏。

### Edge Cases

- 如果会话历史为空或加载失败，应展示空态/错误提示且第三栏保持安全状态。
- 当模块声明不需要第二/第三栏时，布局不得保留残余间距或滚动条。
- 路由不存在（例如访问未知 `/chat/foo/bar`）时，需要可靠地回退至默认模块视图。
- 当消息面板因网络错误无法加载最新内容时，应提供重试入口并保持既有上下文不丢失。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 提供与现有 Sidebar 设计一致的全局布局，左侧为固定 icon-only 主模块导航，可在桌面/移动端一致工作。
- **FR-002**: Chat 模块在主区域内呈现“会话历史 + 消息详情”两栏，第二栏替换 demo 中的 mails 列表，第三栏显示实时消息内容。
- **FR-003**: 会话历史需要与当前会话状态同步（包括刷新、直链访问），点击项需更新 URL 并驱动第三栏内容。
- **FR-004**: Explore 模块在新布局中保留原有文件树+编辑器体验，其文件树位于模块内部（非全局注入），右侧内容与旧版本保持一致。
- **FR-005**: 布局框架须允许模块声明自身栏位需求（单栏/双栏/三栏），未使用的栏位不得渲染或占用宽度。
- **FR-006**: 根据需要更新路由结构（例如 `/chat/:conversationId`），确保深链可直接还原对应模块与子视图。
- **FR-007**: 在模块内容区滚动时，全球导航与主布局保持固定，避免滚动穿透或高度不足问题。

### Key Entities

- **模块（Module）**: 包含 id、显示名称、路由路径以及栏位配置（需要多少个内部面板）。
- **会话（Conversation）**: 具有唯一 path/id、标题、最近活动时间，驱动第二栏列表及第三栏消息区内容。
- **文件树节点（Explorer Node）**: 表示 Explore 模块内的目录/文件，需记录层级、类型与选中状态，用于模块自有双栏布局。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 在桌面端切换模块到内容稳定渲染的时间不超过 1 秒（95% 分位）。
- **SC-002**: Chat 会话在刷新或通过 `/chat/:id` 直链打开时，成功恢复目标会话的比例达到 99%。
- **SC-003**: Explore 模块关键操作（展开文件、打开编辑器、预览）不仅保持原功能，还需在回归测试中 0 重大回归。
- **SC-004**: 针对新增布局，内部评审中至少 90% 的测试者认为交互与旧版本相比更清晰或等价（主观满意度问卷）。

## Assumptions

- 会话历史与消息内容沿用现有后端 API，不需要新增数据结构，只需调整展示与路由。
- Explore 模块仍由现有 store 与订阅驱动，本次仅调整组件组织方式。
- 允许暂不处理移动端手势优化，后续可在独立需求中补强。
