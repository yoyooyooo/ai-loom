# Explorer 页面架构说明（业务侧 SPEC）

本 SPEC 聚焦本需求的前端业务架构与组件拆分，描述 `packages/web/src/routes/explorer.tsx` 的目标结构与状态边界。通用规范请参考 `docs/frontend-architecture.md`。

## 1. 目标与范围

- 把 Explorer 页面按“活动栏 / 侧栏 / 主区 / 浮层”拆分，降低单文件复杂度。
- 使用全局与页面级两层 store 管理状态；服务端数据交给 React Query。
- 保持现有功能与交互不变（目录树、预览/编辑、批注 CRUD、导入导出、回跳）。

## 2. 组件结构

目录（kebab-case）：

```
src/features/explorer/
  pages/explorer-page.tsx           # 页面容器：编排 ActivityBar / SidePanel / MainArea
  components/
    activity-bar.tsx                # 切换：files | annotations
    side-panel/
      file-tree-panel.tsx           # 文件树容器（根目录、选中文件、打开回调）
      annotation-panel.tsx          # 批注列表与操作
    main-area/
      editor-panel.tsx              # 文件查看/Markdown 预览/全文编辑与保存
    annotation-toolbar.tsx          # 选择后浮层（新建/更新/删除）
```

路由：`src/routes/explorer.tsx` 仅渲染 `<ExplorerPage />`。

## 3. 状态与数据边界

- 全局（`src/stores/app.ts`）：
  - `currentDir`、`selectedPath`、`pageSize`
  - 偏好：`activePane`、`wrap`、`mdPreview`（persist `ailoom.app`）

- 页面（`src/stores/explorer.ts`）：
  - `startLine`、`selection`、`showToolbar`、`comment`、`activeAnnId`
  - `full`（编辑态）、`chunkInfo`、`pendingJump`

- 服务端数据（React Query）：
  - 目录树：`['tree', currentDir]`
  - 批注列表：`['annotations']`
  - 文件全文：`fetchFileFull(path)`（按需）

## 4. 关键交互与流程

- 选择文字 → 显示浮层（新建）/打开标记（编辑）
  - 依赖：`explorer.selection/showToolbar/comment/activeAnnId`
  - 写操作：`createAnnotation`/`updateAnnotation`/`deleteAnnotation` 后 `invalidateQueries(['annotations'])`

- 回跳批注 → 定位文件与行号
  - 依赖：`app.selectedPath`、`explorer.startLine/pendingJump`、视图 reveal（Monaco/Markdown）
  - 逻辑：将 `startLine` 前移约半屏，`pendingJump` 在 onLoaded 时消费

- Markdown 预览
  - 依赖：`app.mdPreview`、`fetchFileFull` 加载全文预览用内容

- 全量编辑与保存
  - 依赖：`explorer.full`（content/language/digest）
  - 保存：`saveFile({ path, content, baseDigest })`；冲突提示与 digest 更新

## 5. 文件命名与导入

- 组件与目录一律使用 `kebab-case`；组件导出 `PascalCase`；详见 `docs/frontend-architecture.md`。
- 统一 `@` 为 `src` 别名；避免 `../../../`。

## 6. 非目标项

- 不引入额外 UI 库；shadcn 组件按 CLI 规范安装。
- 不变更 React Query 键与 API 行为。

