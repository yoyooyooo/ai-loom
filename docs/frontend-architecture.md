# 前端架构规范（Feature First + Zustand）

本文档规范 `packages/web` 的前端架构、目录组织、状态管理与命名约定，旨在降低耦合、提升可维护性与可演进性。约定参考并对齐以下内部最佳实践文档：

- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/02-principles-and-architecture/04-project-structure.md
- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/02-principles-and-architecture/05-file-conventions.md
- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/adr/08-why-feature-first-structure.md

> 注意：本文为强约束，新增代码应严格遵守；存量代码按需渐进迁移。

## 1. 顶层原则

- Feature First：以“领域/特性”为单位组织，实现内聚、对外最小暴露。
- 路由瘦身：`src/routes/*` 仅做薄封装与挂载，不承载业务逻辑与副作用。
- 状态集中：所有共享/跨组件状态存放在 `src/stores`（Zustand + persist）。
- 通用复用：与领域无关的通用 UI/编辑器放在 `src/components`，避免耦合到具体 feature。
- 数据获取：服务端数据统一用 React Query，store 只承载 UI/偏好/协作本地态。

## 2. 目录结构（建议）

```
packages/web/src
  app.tsx
  main.tsx
  routes/
    explorer.tsx                    # 薄路由，仅渲染页面（kebab-case 文件名）
  features/
    explorer/
      pages/
        explorer-page.tsx           # 页面容器：布局/编排
      components/
        activity-bar.tsx            # 左侧 ActivityBar（文件/批注）
        side-panel/
          file-tree-panel.tsx       # 封装文件树（注入 root/selectedPath 回调）
          annotation-panel.tsx      # 批注列表与操作
        main-area/
          editor-panel.tsx          # 预览/源码编辑/保存/换行/MD 预览切换
        annotation-toolbar.tsx      # 选择后浮层（新建/更新/删除）
      hooks/
        use-explorer-effects.ts     # 页面副作用集中（回跳、聚焦、外点关闭等）
      constants.ts                  # （可选）本页常量/类型
  stores/
    app.ts                          # 全局：目录/选中文件/页容量/偏好（persist: ailoom.app）
    explorer.ts                     # 页面级：选择/浮层/编辑态/回跳/分片信息
  components/
    editor/
      monaco-viewer.tsx
      markdown-preview.tsx
      monaco-editor-full.tsx
    ui/                             # shadcn/ui，通过 CLI 安装
  lib/
    api/
      client.ts
      types.ts
    config.ts
    utils.ts
  styles/
    globals.css
    monaco-overrides.css
```

## 3. 状态管理（Zustand）

### 3.1 全局 App Store（`src/stores/app.ts`）

- 状态：
  - `currentDir: string` 当前根目录
  - `selectedPath: string | null` 当前选中文件
  - `pageSize: number` 文件分页大小（用于大文件按行加载）
  - 偏好：`activePane: 'files' | 'annotations'`、`wrap: boolean`、`mdPreview: boolean`
- 持久化：`persist({ name: 'ailoom.app' })`
- 动作：`setCurrentDir`、`setSelectedPath`、`setPageSize`、`setActivePane`、`toggleWrap`、`toggleMdPreview`

### 3.2 Explorer Store（`src/stores/explorer.ts`）

- 状态（页面级，本地 UI 态，不持久化）：
  - `startLine: number`、`chunkInfo: { start; end; total } | null`
  - `selection: { startLine; endLine; startColumn?; endColumn?; selectedText } | null`
  - `showToolbar: boolean`、`comment: string`、`activeAnnId: string | null`
  - `full: { content; language; digest } | null`（全量编辑态）
  - `pendingJump: { startLine; endLine; id?; comment? } | null`
- 动作：`setStartLine`、`setSelection`、`openToolbar/closeToolbar`、`setComment`、`setActiveAnnId`、`enterFull/exitFull`、`setChunkInfo`、`setPendingJump/consumePendingJump`、`jumpToAnnotation`、`resetOnPathChange`

> React Query 继续承担：目录树、批注列表、文件内容等服务端数据；store 只放 UI/偏好与交互态。

## 4. 命名约定（强制）

- 文件与目录一律 `kebab-case`（a-b-c）。示例：`explorer-page.tsx`、`file-tree-panel.tsx`、`use-explorer-effects.ts`。
- 组件导出的标识符使用 `PascalCase`：`export function FileTreePanel() {}`。
- Hooks 导出使用 `camelCase` 且以 `use` 前缀：`useExplorerEffects`。
- 类型/枚举使用 `PascalCase`；常量 `SCREAMING_SNAKE_CASE`。

## 5. 文件类型与文件命名

- 何时使用 `.tsx`：文件内出现 JSX（含返回 ReactNode 的组件或带 JSX 的 hook）。否则一律使用 `.ts`。
- 组件文件：`<name>.tsx`（kebab-case），导出 `PascalCase` 组件。
- hooks 文件：`use-<name>.ts[x]`（是否含 JSX 决定后缀），导出 `use<Name>`。
- 工具/常量/类型：`utils.ts`、`constants.ts`、`types.ts`（按需分拆；避免大杂烩）。
- store：`stores/<domain>.ts`，导出 `use<Domain>Store`，必要时 `persist({ name: '<app-scope>' })`。
- Barrel（索引导出）：仅在 feature 边界处允许建立 `index.ts` 聚合同级导出；禁止深层过度 barrel 导致循环依赖。
- 测试与示例：如引入测试，命名为 `*.test.ts[x]` 与 `*.spec.ts[x]`；示例/演示为 `*.demo.tsx`（可选）。

建议逐步把通用编辑器组件重命名为 kebab-case：
- `components/editor/MonacoViewer.tsx` → `components/editor/monaco-viewer.tsx`
- `components/editor/MarkdownPreview.tsx` → `components/editor/markdown-preview.tsx`
- `components/editor/MonacoEditorFull.tsx` → `components/editor/monaco-editor-full.tsx`

> 存量命名可按计划批量迁移，确保 import 更新一致，避免一次性大范围扰动。

## 6. 路由与 Feature 的边界

- 路由层（`src/routes/*`）只负责：拼装页面、注入必要的 store 与 query context。
- Feature 层负责：UI 片段、交互逻辑、副作用（通过 hooks）、本地 UI 状态（通过 `stores/explorer`）。
- 通用组件与领域组件分离：仅当组件不依赖具体领域数据模型时放入 `src/components`。

## 7. UI 与样式规范

- shadcn/ui：所有组件必须通过 CLI 安装。
  - 初始化：`npx shadcn@canary init -c packages/web`
  - 添加组件：`npx shadcn@canary add <component> -c packages/web`
- Tailwind v4：确保接入 `@tailwindcss/vite`，并在 `styles/globals.css` 定义/映射 CSS 变量与 `@theme inline`，使 `bg-muted`、`text-muted-foreground` 等令牌生效。

## 8. 导入顺序与路径规范

- 路径别名：统一使用 `@` 指向 `src` 根；禁止越级的相对路径（如 `../../../`）。
- 导入顺序：内置/第三方 → `@/lib` 与全局 `@/stores` → Feature 内部 → 相对路径（同目录/子目录）。
- 默认导出：优先使用具名导出，减少重命名与循环依赖风险。仅在页面与路由组件允许使用 default 导出。

## 9. React Query 约定

- Query Key：`['tree', currentDir]`、`['annotations']`、`['file', path, range]` 等，按资源名 + 关键参数顺序命名。
- 缓存策略：目录树使用 `staleTime/gcTime`，避免重复请求；写操作后用 `invalidateQueries` 精确失效。
- 错误处理：在调用端对服务端错误进行用户可读提示；必要时在 `lib/api/client.ts` 统一封装错误类型。

## 10. API 层

- `lib/api/client.ts` 仅承载轻量请求封装与类型绑定；复杂拼接/组合逻辑下沉到 Feature 内部的 `services/` 或 hooks。
- 所有 API 类型定义集中在 `lib/api/types.ts`，避免散落在组件中。

## 11. 迁移策略

1. 新增文件全面使用 `kebab-case`，同时在评审中强校验；存量文件按优先级渐进重命名（IDE/脚本统一更新 import）。
2. 将 `src/lib/store/useAppStore.ts` 平移为 `src/stores/app.ts` 并扩展偏好项；过渡期保留 re-export 以避免大范围改动。
3. 拆分 `routes/explorer.tsx`：迁移到 `features/explorer/pages/explorer-page.tsx`，并按“活动栏/侧栏/主区/浮层”组件化拆分。
4. 把领域专属组件移动到对应 feature 目录；仅保留通用组件在 `src/components`。
5. 保持 React Query 键不变，减少缓存抖动；把 localStorage 零散键整合到 `persist(name: 'ailoom.app')`。
6. 渐进完成通用组件的 kebab-case 重命名与导入修复。

## 12. 开发与验证

- 开发热更新：使用者执行 `just server-dev`；Agent 不自行启动服务或构建。
- 如需产出静态资源再用 `just web-build`/`just serve`。
- Rust/后端与 CLI 的命令保持 README/AGENTS.md 既有约定。
