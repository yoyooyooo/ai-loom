# Implementation Tasks: Chat 模块侧边栏整合

> 所有任务均基于分支 `005-chat-sidebar-refresh`，请遵循宪章命名与目录规范。

## Phase 1 — 架构与基础设施

1. **重构 Sidebar 配置能力**  
   - 扩展 `app-sidebar-config.ts` 支持第二栏标签（`secondTabs`）与渲染函数。  
   - 在 `AppSidebar` 组件中加入标签状态管理，渲染标签头与内容容器，并保证窄屏折叠时状态保持。  
   - 为第二栏基础样式补充 `Hover/Active` 状态与滚动容器。

2. **更新导航模块装配**  
   - 调整 `getAppSidebarModules`：为 Explore 模块注入第二栏配置（文件/批注）并默认关闭第三栏。  
   - 确保 `createChatSidebarModule` 保持现有第二、第三栏能力，同时允许额外 header/banners。

3. **重组 Explorer 组件结构**  
   - 移除 `ActivityBar`，将其文件/批注切换迁移至新 Sidebar 标签。  
   - 在 Explorer 模块中使用共享 store 保存当前标签，确保刷新后恢复。  
   - 更新 `explorer-page.tsx`：依赖 Sidebar 提供的第二栏内容而非 ActivityBar，保留主编辑区、批注面板、Chat 嵌入逻辑。

## Phase 2 — 行为联调与体验

4. **历史列表与消息联动**  
   - 验证 Chat 模块第二栏调用现有 HistoryList，第三栏容纳 ChatPanel；确认恢复流程与 banner 展示正常。  
   - 在切换历史时调用 `chatApi.interrupt`、`resumeByPath`，并通过 banner 呈现成功或错误状态。

5. **Explore 标签体验打磨**  
   - 确保文件树/批注面板在窄屏抽屉模式下可正常切换。  
   - 为批注数量添加徽标（若已有数据），同时保留原有错误处理与空态逻辑。  
   - 确认第三栏关闭时主内容区正常填充，避免出现空白占位。

6. **文档与工具链调整**  
   - 更新 `AGENTS.md`（如未自动完成）与 `docs` 中涉及旧 ActivityBar 说明的章节。  
   - 在 `quickstart.md` 验证步骤中补充探索模块标签切换与无第三栏场景检查。  
   - 手动运行 `pnpm -C packages/web lint`（若 available）或 Prettier，确保格式一致。

## Phase 3 — 验证与交付

7. **功能验证**  
   - 按 `quickstart.md` 逐项检查导航高亮、历史恢复、Explore 标签、响应式折叠、错误态。  
   - 在窄屏（<768px）与桌面宽屏分别验证所有栏位显示与折叠行为。  
   - 对 Chat/Explore 模块执行基础冒烟测试，确保路由、WS 订阅、状态管理无回归。

8. **QA 与回归**  
   - 检查 `just dev-all` 热更新流程，确保 Sidebar 改造不影响热重载。  
   - 若可能，补充一两个关键交互的 Vitest/RTL 用例（例如第二栏标签切换状态保存）。  
   - 准备交付说明（PR 描述与验证步骤），强调 ActivityBar 收编与多栏配置化的影响面。
