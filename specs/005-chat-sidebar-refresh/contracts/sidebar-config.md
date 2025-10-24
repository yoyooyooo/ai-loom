# UI Contract: 多栏侧边栏配置

## Overview
- **Purpose**: 统一定义顶层模块导航与多栏内容区的配置方式，确保 Chat/Explore 与未来模块可共享框架。
- **Consumers**: `packages/web/src/app.tsx`, `packages/web/src/components/app-sidebar.tsx`, 各模块注册文件（routes）。

## Configuration Schema

```ts
export type SidebarModuleConfig = {
  id: 'chat' | 'explore' | string
  label: string
  icon?: React.ComponentType<{ className?: string }>
  path: string
  pill?: string
  enabled?: boolean
  columns?: {
    second?: () => React.ReactNode
    secondTabs?: { id: string; label: string; render: () => React.ReactNode }[]
    third?: () => React.ReactNode
  }
}
```

- `enabled` 默认 `true`。当 `false` 时，导航入口完全隐藏。
- `columns.second` / `columns.third` 为懒计算函数，确保渲染时机由宿主控制。
- 若 `columns` 缺失或对应函数不存在，则视为不启用该栏位，同时布局需自动隐藏分隔线并将主内容扩展至剩余空间。

## Expected Behaviors
- 首栏：展示 `label` 与 `icon`，点击后执行 `navigate(path)`，并依据当前路由高亮。
- 第二栏（若存在）：优先渲染 `secondTabs` 指定的标签头；当前激活标签通过 `render` 输出内容；Chat 场景使用单一历史列表，Explore 场景提供“文件/批注”双标签。
- 第三栏（若存在）：渲染返回的节点；Chat 场景为 `ChatPanel` 主界面。
- 当路由切换至不启用第二/第三栏的模块时，Sidebar 应即时隐藏对应栏位，并移除栏位之间的分割线。

## Error Handling
- 若 `columns.second` 返回 `null`，界面应展示空状态文案而非报错。
- 若配置缺失 `path` 或 `id` 重复，应在开发模式下抛出错误，阻止应用加载，以避免导航紊乱。

## Visual Tokens
- 首栏宽度：`var(--sidebar-width-icon)`；第二栏宽度：`var(--sidebar-width)`；第三栏占剩余空间。
- 断点：`md` 及以上展示多栏；`md` 以下折叠为抽屉形式，仅保留首栏入口按钮。
