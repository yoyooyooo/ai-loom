# Research Summary

## Decision 1: Sidebar 结构抽象方式
- **Decision**: 基于现有 `AppSidebar` block 抽象出“首栏导航 + 可选次级栏”配置，而非为每个模块单独克隆 Sidebar。
- **Rationale**: shadcn/ui Sidebar 组件原生支持多 Sidebar 组合，抽象配置能够确保 Chat/Explore 共用样式且便于未来增加模块或隐藏栏位。
- **Alternatives considered**: 
  - *Duplicated Layout per module*: 会导致样式漂移与维护成本上升。
  - *动态渲染单 Sidebar + CSS 变体*: 需要重写 shadcn 行为且在 collapsible/ARIA 处理上风险高。

## Decision 2: 会话历史数据策略
- **Decision**: 沿用 TanStack Query 的 `useInfiniteQuery`（查询键 `['chat','history',{pageSize}]`），把第二栏视作 HistoryList 的宿主，仅注入 UI 框架层的容器。
- **Rationale**: 现有 HistoryList 已有分页与错误处理逻辑，避免重复实现；React Query 的缓存也满足多栏布局下的共享需求。
- **Alternatives considered**: 
  - *在 Sidebar 内重写抓取逻辑*: 增加重复 API 调用与状态切换复杂度。
  - *将历史迁移到 Zustand*: 会失去自动缓存失效与分页控制。

## Decision 3: 第三栏消息区复用策略
- **Decision**: 直接在第三栏托管既有 `ChatPanel` 主体（或抽出的消息子组件），通过选中历史项驱动 `chatActions.reset()/resume`，不重新定义消息容器。
- **Rationale**: ChatPanel 已具备消息渲染、输入区与状态恢复逻辑；嵌入第三栏仅需在布局层面提供滚动与 padding。
- **Alternatives considered**:
  - *在 Sidebar 第三栏重写精简版消息列表*: 无法覆盖完整对话与交互（如停止生成、输入框），用户体验受损。
  - *把 ChatPanel 与 Sidebar 完全解藕*: 需要大量重构并影响 explore 内嵌聊天场景。

## Decision 4: 顶层导航状态来源
- **Decision**: 依赖 React Router 的当前路径决定 active nav，同时保留 `useSidebar` 控制折叠，导航点击触发 `navigate()`；不额外引入全局 store。
- **Rationale**: 路径已天然区分 Chat/Explore；保持轻量且与宪章“简洁优先”一致。
- **Alternatives considered**:
  - *Zustand 全局 activeModule*: 需手动同步路由，存在双向更新风险。

## Decision 5: ActivityBar 收编方式
- **Decision**: 将 Explorer 侧原 `ActivityBar` 能力收编为第二栏标签页（文件 / 批注），复用原 FileTreePanel 与 SideAnnotationPanel，并移除单独的 ActivityBar 组件。
- **Rationale**: 统一导航体验，避免首栏与 ActivityBar 重复承担模块切换职责；Tab 形式更贴合多栏结构且保留原功能。
- **Alternatives considered**:
  - *保留 ActivityBar 作为独立栏位*: 会与首栏导航产生功能重叠，并占用额外宽度。
  - *将批注/文件树移入主内容区域*: 会破坏 Explorer 既有信息分布。

## Decision 6: 响应式策略
- **Decision**: 继承 shadcn 多栏 sidebar 的 `collapsible="icon"/"none"` 能力，结合 Tailwind 断点（md/ lg）与 `useSidebar` 控制，定义阈值 <1024px 时折叠为单栏或可抽屉式。
- **Rationale**: 组件已内置断点变量 `--sidebar-width`, `--sidebar-width-icon`；仅需设置类名与媒体查询即可满足 Edge Cases 要求。
- **Alternatives considered**:
  - *自定义 CSS Grid 布局*: 需重新实现动画与焦点管理，收益不高。

## Reference: shadcn/ui Sidebar 来源与兼容
- **Component Source**: 基于 2024-09-12 更新的 shadcn/ui Blocks「App Sidebar」示例抽取（https://ui.shadcn.com/blocks#application-ui/app-sidebar）。
- **Version Compatibility**: 验证于 React 18.3 + Tailwind CSS v4 + Radix UI ^1.1（与仓库依赖一致），确认 Sidebar API（`Sidebar`, `SidebarMenuButton`, `useSidebar` 等）在当前 CLI 生成的组件集中保持稳定，无破坏性变更记录。
- **Integration Notes**: 需确保 `@radix-ui/react-dialog` ≥1.1.15、`lucide-react` ≥0.545.0，以支撑 Sidebar 折叠动画与图标尺寸；若升级 shadcn 组件，优先复刻 CLI 生成物再同步局部定制。
