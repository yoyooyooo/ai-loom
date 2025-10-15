# 前端架构（Vite + React + shadcn/ui + TailwindCSS）

## 目标

- 快速开发 + 清晰分层：Vite 打包与 HMR、React 18、Tailwind 原子化、shadcn/ui 组件体系。
- 稳定可维护：引入 TanStack Query 管理数据请求与缓存、Zustand 管理 UI 状态。
- 仅做查看与批注：Monaco 作为只读查看器，提供 Decorations 与回跳。

## 技术栈

- 构建：Vite + TypeScript
- UI：React 18 + shadcn/ui（Radix primitives）+ TailwindCSS
- 状态：Zustand（UI 状态）+ TanStack Query（API 数据）
- 路由：React Router v6
- 编辑器：monaco-editor + vite-plugin-monaco-editor（或 @monaco-editor/loader）

## 目录结构（packages/web）

```
packages/web
├─ index.html
├─ vite.config.ts
├─ (可选) tailwind.config.ts
├─ (可选) postcss.config.js
├─ src/
│  ├─ main.tsx
│  ├─ app.tsx
│  ├─ routes/
│  │  ├─ explorer.tsx         # 目录树 + 文件视图
│  │  └─ settings.tsx
│  ├─ components/
│  │  ├─ editor/MonacoViewer.tsx
│  │  ├─ annotation/AnnotationList.tsx
│  │  ├─ annotation/SelectionToolbar.tsx
│  │  └─ ui/...(shadcn 生成组件)
│  ├─ features/
│  │  ├─ annotations/
│  │  └─ stitch/
│  ├─ lib/
│  │  ├─ api/client.ts        # fetch 封装 + 基地址
│  │  ├─ store/useAppStore.ts # Zustand（当前文件、选区等）
│  │  ├─ hooks/useClipboard.ts
│  │  └─ utils/format.ts
│  ├─ styles/globals.css      # Tailwind 入口（v4：@import "tailwindcss"）与主题变量
│  └─ env.d.ts
└─ public/
```

## 初始化步骤

1) 创建工程与依赖
- `pnpm create vite@latest web --template react-ts`
- `cd web && pnpm add @tanstack/react-query zustand react-router-dom monaco-editor`
- `pnpm add -D vite-plugin-monaco-editor tailwindcss postcss autoprefixer @types/node`
- `npx shadcn@latest init`（按向导生成 `components` 与 `lib`）

2) 配置 Tailwind（推荐 v4）
- 安装：`pnpm add tailwindcss @tailwindcss/vite`
- 在 `vite.config.ts` 增加插件：`import tailwindcss from '@tailwindcss/vite'` 并加入 `plugins: [react(), tailwindcss()]`
- `src/styles/globals.css`：加入 `@import "tailwindcss";` 并在 `main.tsx` 引入该样式。
- 说明：若使用 Tailwind v3，请使用旧流程（`npx tailwindcss init -p` + `@tailwind base/components/utilities`），并将 shadcn CLI 固定到 `shadcn@2.3.0`。

3) 配置 Vite（vite.config.ts）
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import monaco from 'vite-plugin-monaco-editor'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss(), monaco({
    languageWorkers: ['editorWorkerService','javascript','typescript','json','css','html'],
  })],
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
})
```

4) shadcn/ui 组件
- 初始化后，通过 `npx shadcn@latest add button input dialog ...` 拉取所需组件。
- 全局主题：使用 class 切换（`dark`），与 Tailwind `dark:` 变体配合。

## 关键模块说明

- 目录树与文件视图
  - `GET /api/tree?dir=...` 懒加载；`components` 提供 `TreeView`（可先用简单列表/缩进样式）。
  - `GET /api/file?path&startLine&maxLines` 分页渲染至 `MonacoViewer`，提供“加载更多”。

- 批注
  - 创建/编辑/删除：调用 `/api/annotations*`；`AnnotationList` 展示与回跳。
  - 选区悬浮条：`SelectionToolbar`（shadcn `Popover`/`Toolbar`），支持“新建/复制原文/±1 行/取消”。

- 生成器（Stitch）
  - 发起 `POST /api/stitch?templateId&maxChars`；展示 `prompt` 与 `stats`，提供一键复制（含回退方案）。

- 状态管理
  - `Zustand`：存 UI 层状态（当前文件、临时选区、主题等）。
  - `React Query`：管理请求、缓存与加载态（`/api/tree`、`/api/file`、`/api/annotations`）。

- Monaco 集成
  - 只读模式、禁用 minimap；超大文件进入“只读/纯文本”模式；整行 Decorations + Gutter 标识。
  - 大文件策略与分页规则遵循路线图默认阈值（2MB/50k 软，5MB/200k 硬）。

## 环境变量与基地址

- `VITE_API_BASE`（可选）：默认同源；如跨源联调使用此变量配置。
- 生产构建输出至 `dist/`，由后端静态托管（路径 `/`）。

## 可访问性与主题

- shadcn/ui + Radix 具备良好 A11y 基线；补充键盘可达性测试。
- 主题：class 切换（`dark`）；Tailwind 配置 `darkMode: 'class'`，为主要组件提供浅色/深色变体。

## 性能要点

- 懒加载 Monaco 与语言 workers；仅启用必要语言。
- 移除 minimap/语义高亮；列表虚拟化（注解列表）。
- 静态资源体积控制：Vite 分包、`vite-plugin-monaco-editor` 精简打包。

## 验收清单（前端）

- 目录树懒加载无阻塞；文件分页加载与“加载更多”可用。
- 选区 → 新建批注 → 回跳流程顺畅；键盘操作全流程可达。
- 生成器生成与复制成功；剪贴板回退可用。
- 主题切换可用；深浅色对比度达标。
- 应用 Provider（入口）
  - 在 `main.tsx` 中包裹 `QueryClientProvider` 与 `BrowserRouter`：
  ```tsx
  import React from 'react'
  import ReactDOM from 'react-dom/client'
  import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
  import { BrowserRouter } from 'react-router-dom'
  import App from './app'
  import './styles/globals.css'

  const queryClient = new QueryClient()

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </React.StrictMode>
  )
  ```
