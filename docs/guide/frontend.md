# 前端结构与流程（已实现）

技术栈与约束
- Vite + React 18 + TypeScript + Tailwind v4 + shadcn/ui（通过 CLI 安装）+ Monaco。
- 别名：`@` → `src`；文件/目录一律 `kebab-case`；组件导出使用 PascalCase。
- 入口 Provider：在 `src/main.tsx` 包裹 `QueryClientProvider` 与 `BrowserRouter`（已实现）。

目录（关键）
- `src/routes/explorer.tsx`：薄路由，仅渲染 `<ExplorerPage />`
- `src/features/explorer/pages/explorer-page.tsx`：页面容器（ActivityBar / SidePanel / MainArea 编排）
- `src/features/explorer/components/*`：文件树、批注面板、编辑器视图等
- `src/stores/app.ts`：全局偏好与当前文件
- `src/stores/explorer.ts`：页面 UI 状态（选区/浮层/回跳/编辑态）
- `src/lib/api/*`：API 封装（axios `http` 实例、错误包装）

状态与 Query Key
- React Query：
  - 目录树：一律使用三段式 `['tree', root, dir]`（顶层 `dir='.'`），包含页面预热/ensureQueryData/useIsFetching 等全部场景
  - 批注列表：`['annotations']`
  - 文件分页：`['file', path, startLine, maxLines]`
- Zustand：
  - `useAppStore`（persist: `ailoom.app`）：`currentDir/selectedPath/pageSize/activePane/wrap/mdPreview`
 - `useExplorerStore`：`startLine/selection/showToolbar/comment/activeAnnId/full/chunkInfo/pendingJump`

WS 与订阅（Explorer）
- 订阅桥：`features/explorer/subscriptions.ts` 维护 `tree/file/annotations` 订阅（随页面装载/卸载）。
- 失效与直改：`features/explorer/ws-invalidators/*` 分别处理文件/目录树/批注事件 → 精确 `invalidateQueries` 或直接更新列表缓存；聚合于 `features/explorer/invalidations.ts` 并在 `explorer-page.tsx` 调用 `useExplorerInvalidations()` 安装。
- 策略：读取优先 WS（短窗熔断回退 REST），写入默认 REST，写后由 WS 广播驱动 UI 同步。

主要交互
- 目录树：懒加载单层（根据展开状态构建）；本地存储记忆展开集合。
- 文件查看：MonacoViewer 分页加载，近顶部向上拼接、近底部向下拼接；展示装饰（inline + gutter）。
- Markdown 预览：将 remark AST 转 HTML，保留 sourcepos，做子串级高亮与点击命中（与 Monaco 装饰统一）。
- 批注：选区 → 悬浮工具条（新建/更新/删除）；列表支持按文件分组与回跳（半屏提前）。
- 全量编辑：小文件（≤512KB）可进入 `MonacoEditorFull`，保存走 `baseDigest` 冲突检测。

可用性与样式
- 进度指示：侧栏顶部循环条（VSCode 风格）。
- 高亮：Monaco 关闭多余干扰（词/括号等），仅保留标注范围的 inline 背景与 gutter 标记；Markdown 预览侧使用相同色系。

实现提示（规范对齐）
- `FileChunk` 字段命名已与后端对齐为 camelCase（见 `api.md`）。
- 组件与文件命名统一为 `kebab-case`；如存在个别不一致命名（如 `MonacoViewer.tsx`），将按计划调整，当前仍以运行稳定优先。
