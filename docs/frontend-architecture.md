# 前端架构规范（Feature First + Zustand）

本文档规范 `packages/web` 的前端架构、目录组织、状态管理与命名约定，旨在降低耦合、提升可维护性与可演进性。约定参考并对齐以下内部最佳实践文档：

- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/02-principles-and-architecture/04-project-structure.md
- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/02-principles-and-architecture/05-file-conventions.md
- /Users/yoyo/projj/git.imile.com/ux/best-practice/docs/adr/08-why-feature-first-structure.md

> 注意：本文为强约束，新增代码应严格遵守；存量代码按需渐进调整。

## 1. 顶层原则

- Feature First：以“领域/特性”为单位组织，实现内聚、对外最小暴露。
- 路由瘦身：`src/routes/*` 仅做薄封装与挂载，不承载业务逻辑与副作用。
- 状态集中：所有共享/跨组件状态存放在 `src/stores`（Zustand + persist）。
- 通用复用：与领域无关的通用 UI/编辑器放在 `src/components`，避免耦合到具体 feature。
- 数据获取：服务端数据统一用 React Query，store 只承载 UI/偏好/协作本地态。

### 1.1 多栏侧边栏框架（AppShell）

- `packages/web/src/app.tsx` 统一承载应用外壳（AppShell），通过 `AppSidebar` 布局首栏导航 + 可选多栏内容。
- 顶层模块导航配置集中在 `packages/web/src/components/app-sidebar-modules.ts`，依赖 `SidebarModuleConfig` 描述可见性、路径、栏位声明。
- 首栏导航始终存在；第二、第三栏由模块按需提供 renderer，未声明的栏位自动隐藏且不保留占位。
- 移动端（`< md`）由 `AppSidebarMobileTrigger` 控制抽屉式展开；桌面端保持多栏并遵循 `--sidebar-width` 变量。
- Codex 聊天模块的历史列表/消息面板位于 `features/codex-chat/`，后续若引入多 Provider，再通过通用聊天层做聚合。

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
  - `currentRoot: string` 当前根（供三段式 Query Key 使用）
  - `currentDir: string` 当前视图目录（相对 `currentRoot`）
  - `selectedPath: string | null` 当前选中文件
  - `pageSize: number` 文件分页大小（用于大文件按行加载）
  - 偏好：`activePane: 'files' | 'annotations'`、`wrap: boolean`、`mdPreview: boolean`
- 持久化：`persist({ name: 'ailoom.app' })`
- 动作：`setCurrentRoot`、`setCurrentDir`、`setSelectedPath`、`setPageSize`、`setActivePane`、`toggleWrap`、`toggleMdPreview`

### 3.2 Explorer Store（`src/stores/explorer.ts`）

- 状态（页面级，本地 UI 态，不持久化）：
  - `startLine: number`、`chunkInfo: { start; end; total } | null`
  - `selection: { startLine; endLine; startColumn?; endColumn?; selectedText } | null`
  - `showToolbar: boolean`、`comment: string`、`activeAnnId: string | null`
  - `full: { content; language; digest } | null`（全量编辑态）
  - `pendingJump: { startLine; endLine; id?; comment? } | null`
- 动作：`setStartLine`、`setSelection`、`openToolbar/closeToolbar`、`setComment`、`setActiveAnnId`、`enterFull/exitFull`、`setChunkInfo`、`setPendingJump/consumePendingJump`、`jumpToAnnotation`、`resetOnPathChange`

> React Query 继续承担：目录树、批注列表、文件内容等服务端数据；store 只放 UI/偏好与交互态。

### 3.3 Slice-first Store 模式

- 状态容器按“slice 工厂”拆分：每个 slice 负责一个明确的子域（如 `conversationSlice`、`messageSlice`、`exploreSlice`），在主 store 中通过 `create()` 合成。这样便于测试、类型推导与后续迁移到多 Provider。示例：`packages/web/src/features/codex-chat/stores/chat/`。
- `features/codex-chat/stores/chat/index.ts` 仅负责组合 `createConversationSlice` + `createMessageSlice`，并导出 `codexChatActions`；实际业务逻辑位于 `message-slice.ts`、`helpers.ts` 等文件。
- Provider 维度的状态（模型、额度、覆盖、token 统计）集中在 `packages/web/src/stores/codex-chat-provider.ts`，按 `conversationId` 分桶，缺省桶 `__default__` 代表待创建会话。未来扩展到多 Provider 时，可改造为 `sessions[providerId][conversationId]`。
- 新增 store 时优先沿用此模式：`create<Domain>Slice(set, get)` + `create<State>` 入口文件，确保动作/状态归属清晰，便于 tree-shaking 与单元测试。

### 3.4 Slice × 类型模式（StoreCreator 复用，强制）

为避免各 slice 重复声明中间件类型、提高类型推导与复用性，统一采用“在 store 层声明 `StoreCreator<TSlice>`，各 slice 复用”的模式。此规范等同于示例仓库 `examples/feature-skeleton/stores/index.store.ts` 的做法，并与本仓库 `chat-turns` 的 `ChatTurnStoreCreator` 一致。

规范要点：
- 在 store 的 `types.ts`（或同文件上方）聚合最终 Store 类型，并声明统一的 `StoreCreator<TSlice>`，将本 store 需要的中间件一次性写入。
- 每个 slice 工厂以 `StoreCreator<Slice>` 为类型签名；内部可直接使用 `immer` 的可变写法，且 `get()` 能正确感知其它 slice。
- 入口 `index.store.ts` 用 `create<FinalStore>()(middlewares(...))` 合并所有 slice；中间件仅在此处配置，不在切片中重复。

最小模板：

```ts
// types.ts（或本文件顶部）
import type { StateCreator } from 'zustand';

export interface AState { /* ... */ }
export interface BState { /* ... */ }
export interface Actions { /* ... */ }

export type FinalStore = { a: AState; b: BState; actions: Actions };

// 统一本 store 需要的中间件（按需替换/增减）
export type StoreCreator<TSlice> = StateCreator<
  FinalStore,
  [
    ['zustand/immer', never],
    ['zustand/subscribeWithSelector', never] // 或 ['zustand/devtools', never]
  ],
  [],
  TSlice
>;

// a.slice.ts
export type ASlice = FinalStore['a'];
export const createASlice: StoreCreator<ASlice> = (set, get) => ({
  /* 状态与动作；可用 set(state => { state.a.xxx = ... }) */
});

// b.slice.ts
export type BSlice = FinalStore['b'];
export const createBSlice: StoreCreator<BSlice> = (set, get) => ({ /* ... */ });

// actions.slice.ts（可选：把跨切片动作集中到 actions 下）
export type ActionsSlice = FinalStore['actions'];
export const createActions: StoreCreator<ActionsSlice> = (_set, get) => ({
  /* 可直接调用 get().a / get().b 的方法与状态 */
});

// index.store.ts（唯一地方组合中间件与切片）
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';

export const useStore = create<FinalStore>()(
  subscribeWithSelector(
    immer((...args) => ({
      a: createASlice(...args),
      b: createBSlice(...args),
      actions: createActions(...args),
    }))
  )
);
```

落实要求：
- 新增/改造的 store 必须提供统一的 `StoreCreator<TSlice>`；如需 `devtools/persist/subscribeWithSelector`，务必在该类型中声明并在入口一次性套用。
- 跨切片动作建议集中在 `actions` 下，避免相互隐式调用导致耦合不清；如需订阅派发桥（RxJS/epic），在入口文件建立订阅，避免切片内部管理订阅的生命周期。

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

> 存量命名可按计划批量调整，确保 import 更新一致，避免一次性大范围扰动。

## 6. 路由与 Feature 的边界

- 路由层（`src/routes/*`）只负责：拼装页面、注入必要的 store 与 query context。
- Feature 层负责：UI 片段、交互逻辑、副作用（通过 hooks）、本地 UI 状态（通过 `stores/explorer`）。
- 通用组件与领域组件分离：仅当组件不依赖具体领域数据模型时放入 `src/components`。

## 7. UI 与样式规范

- shadcn/ui：所有组件必须通过 CLI 安装。
  - 初始化：`npx shadcn@canary init -c packages/web`
  - 添加组件：`npx shadcn@canary add <component> -c packages/web`
- Tailwind v4：确保接入 `@tailwindcss/vite`，并在 `styles/globals.css` 定义/映射 CSS 变量与 `@theme inline`，使 `bg-muted`、`text-muted-foreground` 等令牌生效。
- 文本换行：统一使用 `wrap-break-word`（替代旧的 `wrap-break-word`）。

### 7.1 条件渲染选型：ts-pattern（强制）

- 目的：提升可读性与类型安全，避免多层三元/if-else/switch 的嵌套复杂度。
- 约定：组件内“按类型/状态分支”的渲染统一使用 `ts-pattern` 的 `match().with().otherwise()`。
- 使用建议：
  - 将复杂分支拆成小型纯函数，在 `match` 中组合调用，保持 JSX 简洁。
  - 对新增枚举态，优先用 `with()` 明确覆盖，兜底用 `otherwise()`。
  - 避免在 `match` 中直接编写过长 JSX，抽象后返回。
- 依赖：`packages/web` 已添加 `ts-pattern`。

## 8. 导入顺序与路径规范

- 路径别名：统一使用 `@` 指向 `src` 根；禁止越级的相对路径（如 `../../../`）。
- 导入顺序：内置/第三方 → `@/lib` 与全局 `@/stores` → Feature 内部 → 相对路径（同目录/子目录）。
- 默认导出：优先使用具名导出，减少重命名与循环依赖风险。仅在页面与路由组件允许使用 default 导出。

## 9. React Query 约定

- Query Key：统一按“资源名 + 关键参数顺序”命名；目录树一律使用三段式键：`['tree', root, dir]`（顶层 `dir='.'`），以支持多根与精确失效。文件与批注保持现状：`['file', path, startLine, maxLines]`、`['annotations']`。
- 迁移要求：不得再使用两段式 `['tree', currentDir]`。涉及预热（ensureQueryData/useIsFetching/useQuery）等场景均需使用三段式键，并在筛选时同时匹配 `root` 与 `dir` 两段参数。
- 缓存策略：目录树设置 `staleTime/gcTime`，避免重复请求；写操作后用 `invalidateQueries` 精确失效。
- 错误处理：在调用端对服务端错误进行用户可读提示；必要时在 `lib/api/client.ts` 统一封装错误类型。

## 9.1 Query × RxJS 融合（偏好）

- 分工清晰：
  - React Query：用于“查询类接口”与快照（config/列表/history/snapshot 等）。
  - RxJS：用于“流式/推送/轮询”类能力（WS、短时轮询、增量合并等）。
- 融合方式：
  - RxJS 产出的最新快照，应同时写入 QueryClient（`queryClient.setQueryData([...], snapshot)`），使“查询侧”也能直接消费最新状态（避免重复请求）。
  - Query Key 统一命名：`['chat','session']`、`['chat','sessionSnapshot', conversationId]`、`['chat','history',{pageSize}]` 等。
- 轮询偏好：
  - 用 RxJS + `observable-hooks`（`useSubscription`）实现，避免组件里 `setInterval`。
  - 必须具备双保险：最长时长（如 30s）与“连续无增量阈值”（如 4 次）二者任何满足即停止。
  - 轮询间隔建议 2.5s（可通过 env 调整）。

## 10. API 层

## 10. API 层

- `lib/api/client.ts` 仅承载轻量请求封装与类型绑定；复杂拼接/组合逻辑下沉到 Feature 内部的 `services/` 或 hooks。
- 所有 API 类型定义集中在 `lib/api/types.ts`，避免散落在组件中。

## 10.1 恢复（resume）与实时（live）

- 后端 `/api/chat/conversations/resume` 返回 base `history` 与归一化 `chat.*` 事件；并附带启发式 `inProgress`（是否“可能仍在进行中”）。
- 前端在 Store Action（例如 `chat-resume.ts/processResumeResult`）中一次性：
  - 幂等落地 base history + events（`chatTurnActions.loadSnapshot`）；
  - 应用 provider `capabilities/overrides`；
- 实时增量仅依赖 WebSocket：恢复后立刻订阅 `chat` topic，并在重连时调用 `events.resume({ topic:'chat', filter:{ conversationId } })` 补偿。

## 11. 组件封装与副作用（偏好）

- 组件应尽量“无状态/无副作用”。复杂的副作用与状态迁移都收敛到 Store Action 或 Service Hook。
- 模式：
  - Store（Zustand）：集中承载 UI/跨组件状态，并提供动词化 Action（`processResumeResult`、`setResumeBaseHistory` 等）。
  - Service Hook：组合 Query/Rx 与 Store Action，导出最小接口供页面调用。
  - 页面组件：仅读取 Store 状态，调用 Service Hook 提供的动作，不自行拼装副作用。
- 命名与可读性：
  - 动作用动词短语；Observable 以 `$` 结尾（如 `poll$`），Subject **必须** 以 `$$` 结尾（如 `events$$`）。
  - 同名 Subject/Observable 不得在不同文件起别名；跨模块复用时直接导入原符号。
  - 避免长 `useEffect`；若逻辑超过 10 行，优先下沉到 Store/Service。

### 11.1 RxJS 管道与 Subject 管控（新增）

- 单一事实源：跨模块共享的 Subject 统一集中在 `@/lib/ws/runtime-subjects` 或对应 `@/lib` 目录下的领域文件，由该文件导出 `$$` 结尾的 Subject 与工厂函数。Feature 内不得随意在模块顶层 `new Subject()`。
- 组合式偏好：所有 WS/流式逻辑需以 RxJS 管道组合完成（`pipe` + 运算符），禁止在订阅外额外维护 `Map/Set` 计数或散落的定时器；必要状态封装成 `Observable` 再由订阅端消费。
- 生命周期：`subscribe()` 返回的 `Subscription` 须在同一作用域统一 `unsubscribe()`，或改写为 `Observable` → `tap` → `finalize` 的组合式管道。
- 测试场景：仅在 Vitest/RTL 场景允许使用临时 `new Subject()` 构造源流，命名仍遵循 `source$$`、`begin$$` 等约定，并确保在用例结束前显式 `unsubscribe()`。

## 12. 开发与验证

## 11. 命名与结构调整计划

1. 新增文件全面使用 `kebab-case`，在评审中强校验；存量文件按优先级渐进重命名（通过 IDE/脚本统一更新 import）。
2. 将 `src/lib/store/useAppStore.ts` 平移为 `src/stores/app.ts` 并扩展偏好项；通过统一路径更新消除临时重导出。
3. 拆分 `routes/explorer.tsx`：调整为 `features/explorer/pages/explorer-page.tsx`，并按“活动栏/侧栏/主区/浮层”组件化拆分。
4. 把领域专属组件移动到对应 feature 目录；仅保留通用组件在 `src/components`。
5. 统一将目录树 Query Key 迁移为三段式 `['tree', root, dir]`（包括页面预热/ensureQueryData/useIsFetching 等），并批量更新筛选断言逻辑；把 localStorage 零散键整合到 `persist(name: 'ailoom.app')`。
6. 渐进完成通用组件的 kebab-case 重命名与导入修复。

## 12. 开发与验证

- 开发热更新：使用者执行 `just server-dev`；Agent 不自行启动服务或构建。
- 如需产出静态资源再用 `just web-build`/`just serve`。
- Rust/后端与 CLI 的命令保持 README/AGENTS.md 既有约定。

## 12.1 构建与缓存（Turborepo）

- 已集成 Turborepo（仅作用于前端 `packages/web`）：
  - 根目录新增 `turbo.json` 与 `package.json`（devDependencies: `turbo`）。
  - 命令示例：
    - `pnpm turbo run dev --filter=ai-loom-web`（等价于到 `packages/web` 执行 `pnpm dev`，不缓存）
    - `pnpm turbo run build --filter=ai-loom-web`（缓存 `dist/**` 产物，增量复用）
    - `pnpm turbo run test --filter=ai-loom-web`
  - 也可使用根脚本：`pnpm dev/build/test`。
- Rust 构建：沿用 `cargo`（已具备增量编译）；后续如需统一入口，可在 `packages/rust/ailoom-server` 旁新增一个 npm 包，仅做脚本代理 `cargo build -p ailoom-server`（默认不建议缓存跨平台产物）。
- 远端缓存（可选）：后续可绑定 Vercel Remote Cache 或自建 Turborepo 远端缓存服务，提升多人协作与 CI 速度。

## 13. WS 订阅与缓存失效（Explorer）

- 策略约定：优先 WS（`wsPrefer`），短窗熔断回退 REST；写入默认 REST，写后由服务端广播事件维持一致性（详见 AGENTS.md“WS 开发策略”）。
- 订阅桥（按特性组织）：`src/features/explorer/subscriptions.ts` 仅维护 Explorer 所需的 `tree/file/annotations` 订阅，随页面挂载/卸载自动重建。聊天模块另行维护全局事件处理器（`subscribeChatEvents`），默认只保留运行时专用订阅（`methods: ['chat.info.runtime.generating', 'session.runtime']`），会话级订阅按需由页面/组件引入。
- 领域化 invalidators：
  - 文件：`src/features/explorer/ws-invalidators/file-invalidator.ts`（digest 短窗去重 + RAF 合批，失效 `['file', path]` 与所属目录树）
  - 目录树：`src/features/explorer/ws-invalidators/tree-invalidator.ts`（`impactedPaths` 最小目录集，`truncated/缺摘要` 粗粒度刷新当前视图根）
  - 批注：`src/features/explorer/ws-invalidators/annotations-invalidator.ts`（created/updated/deleted 直改列表或整表失效）
  - 聚合安装：`src/features/explorer/invalidations.ts` 导出 `useExplorerInvalidations()`，在 `explorer-page.tsx` 中调用。
- Query Key：继续遵循三段式 `['tree', root, dir]` 与 `['file', path, ...]`、`['annotations']` 的规范，invalidators 仅做精确失效或直改缓存，不存储业务状态。
