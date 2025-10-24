# Data Model: Chat 模块侧边栏整合

## ModuleNavItem
- **Description**: 顶层模块导航条目（Chat、Explore 等）。
- **Fields**:
  - `id` (string, required): 唯一标识，用于路由匹配（如 `chat`, `explore`).
  - `label` (string, required): 展示名称（本地化后文案）。
  - `icon` (ReactNode ref, optional): 图标引用，遵循 shadcn/ui 图标尺寸。
  - `path` (string, required): React Router 路径，须保持稳定以支持深链。
  - `pill` (string, optional): 附加状态标签（例如 Beta、数量）。
  - `enabled` (boolean, default `true`): 控制是否展示；不展示即不渲染入口。
  - `columns` (object, optional): 模块声明的栏位使用情况，见 `SidebarColumnConfig`。
- **Relationships**:
  - 1:N 与 `SidebarColumnConfig`（每个模块带一份配置）。
- **Validation**:
  - `id`、`path` 必须唯一。
  - 当 `enabled=false` 时必须提供不可见原因（用于审计/日志）。

## SidebarColumnConfig
- **Description**: 描述模块对第二、第三栏的使用策略。
- **Fields**:
  - `useSecondColumn` (boolean, default `false`): 是否渲染第二栏。
  - `useThirdColumn` (boolean, default `false`): 是否渲染第三栏。
  - `secondColumnNode` (ReactNode, optional): 二栏内容（例如 HistoryList）。
  - `secondColumnTabs` (TabConfig[], optional): 当二栏需要多视图时的标签集合。
  - `thirdColumnNode` (ReactNode, optional): 三栏内容（例如 ChatPanel）。
- **Validation**:
  - 若 `useSecondColumn=true` 时 `secondColumnNode` 不得为空。
  - 若 `useThirdColumn=true` 时 `thirdColumnNode` 不得为空。
  - 默认值允许模块仅渲染首栏，满足“不要强制多栏”的约束。
  - `secondColumnTabs` 存在时，`secondColumnNode` 作为当前激活标签的渲染函数。

## TabConfig
- **Description**: 描述侧边栏第二栏的标签切换选项。
- **Fields**:
  - `id` (string, required): 标签唯一标识（如 `files`, `annotations`）。
  - `label` (string, required): 展示名称。
  - `render` (() => ReactNode, required): 对应内容渲染函数。
- **Validation**:
  - 至少包含一个条目；探索模块必须包含 `files` 与 `annotations` 两个标签。
  - 与 `SidebarColumnConfig.secondColumnTabs` 联动时，需维护激活状态于模块自身 store 中。

## ConversationHistoryEntry
- **Description**: 聊天历史列表项。
- **Fields**:
  - `path` (string, required): 唯一恢复路径（`/chat/histories/{id}`）。
  - `preview` (string, required): 列表展示摘要；为空时显示占位文案。
  - `timestamp` (string ISO, required): 最后活动时间。
  - `model` (string, optional): 生成模型名称。
  - `status` (`'active' | 'archived'`, default `'active'`): 影响显示状态。
- **Relationships**:
  - 更新 `ChatSessionState` 时根据 `path` 恢复。
- **Validation**:
  - `timestamp` 必须可解析；排序后用于第二栏倒序渲染。
  - `path` 与 `conversationId` 映射需在 API 级别明确（由后端保证）。

## ChatSessionState
- **Description**: 聊天模块当前会话状态（Zustand store）。
- **Fields**:
  - `conversationId` (string | null): 活跃对话 ID。
  - `messages` (Message[]): 对话消息。
  - `generating` (boolean): 是否正在生成响应。
- **State Transitions**:
  1. `idle` → `resuming`: 用户点击历史项，触发 `chatApi.resumeByPath`。
  2. `resuming` → `ready`: API 返回成功，`conversationId` 与 `messages` 重置。
  3. 任一状态 → `error`: API 失败；banner 显示错误，状态回退 `idle`。
  4. `generating=true` 时收到切换指令 → 先执行 `chatApi.interrupt`，再进入 `resuming`。
- **Validation**:
  - 切换历史前必须确认 `generating` 状态；若未中断不可直接覆盖。
  - `messages` 更新应保证滚动区域可用（交由 ChatPanel 管理）。

## ResponsiveSidebarState
- **Description**: 控制多栏在不同断点下的折叠情况。
- **Fields**:
  - `isIconOnly` (boolean): 首栏是否仅展示图标。
  - `isMobileOverlay` (boolean): 窄屏下是否以抽屉方式展示。
  - `open` (boolean): 当前可见性，由 `useSidebar()` 管理。
- **Validation**:
  - < 768px 自动启用 `isMobileOverlay`，防止多栏挤压。
  - `open` 状态变化必须驱动 ARIA 属性更新（复用 shadcn 组件内建行为）。
  - 标签切换状态需在窄屏抽屉模式下保持一致，避免重复选择。
