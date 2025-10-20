# 前端设计（WS 客户端与 React Query，对接初稿）

目标：在不破坏现有页面/状态结构下，引入 `ws` 传输层封装（RxJS），优先用 WS 完成读取与实时推送，REST 作为写入与兜底通道；利用推送事件驱动缓存失效与 UI 同步。本文作为前端侧 SSoT，统一订阅形态（主题+过滤）、Query Key 维度与错误/回退语义。

Phase 边界（前端首版约定）：
- Phase 1 仅提供 `singleton`（单连接）；`registry`/多连接留作 Phase 3。
- Phase 1 仅将“读取类请求”接入 `wsPrefer`；写入类仍走 REST，但写后由服务端广播事件维持一致。
- 目录树 QueryKey 统一为三段式 `['tree', root, dir]`（顶层 `dir='.'`），页面预热等场景也按此规范。

## 通道策略（Hybrid，已决策）

- 读取：`tree.get`、`file.getChunk`、`file.getFull`、`annotations.list` 优先经 WS；WS 断线时自动回退 REST 读取。
- 写入：默认使用 REST（保存/批注 CRUD/工具型接口）；可按需提供 WS 写方法，但无论哪种写，服务端都会推送相应事件同步前端。
- 推送：事件一律经 WS 实时下发（`file.changed`、`tree.changed`、`annotations.*`、`annotations.verify.done` 等），并仅通过“主题 + 过滤”订阅（不提供按任意方法名的订阅）。

## 封装与用法（RxJS 版）

- 新增：`packages/web/src/lib/ws/rx-client.ts`
  - `call$(method, params, timeoutMs)`：返回 Observable（供 React Query 用 `firstValueFrom`）
  - `subscribeTopic$(topic, filter)`：基于“主题 + 过滤”的事件流；当 Observable 被订阅时调用 `subscribe` RPC，取消订阅时调用 `unsubscribe` RPC；重连自动恢复订阅（推荐）。仅接受单一 `topic: 'file'|'tree'|'annotations'`，不支持传入方法数组；返回 `Observable<{ method: string; params: any }>` 以区分 `created/updated/deleted` 等子方法。若确需“多方法”过滤，请在管道内按 `method` 过滤或合并多个订阅（见下方示例）。
  - `notification$(method)`：仅用于接收服务端的全局低频通知（如 `session.welcome`/`session.ping`），不走服务端订阅；业务事件请使用 `subscribeTopic$`。
  - 自动重连（指数退避+抖动）、心跳（收到 `session.ping` 后发送 `session.pong`）、请求超时、错误映射
- 单例：`packages/web/src/lib/ws/singleton.ts` 暴露 `ws`，集中配置 URL/重连策略
- 环境变量
  - `VITE_USE_WS`：WS 默认开启；若需禁用请设置为 `0` 或 `false`；
  - `VITE_WS_URL`：默认 `ws://127.0.0.1:${AILOOM_PORT}/ws`（与 REST 同源时可省略）。
  - `VITE_WS_TIMEOUT_MS`：WS 单次调用默认超时（默认 15000）。
  - `VITE_WS_FUSE_MS`：短窗熔断时长（默认 1500）；某方法命中传输/能力错误后，在该窗口内直接回退 REST，避免抖动。
- Vite 代理（开发）
  - `vite.config.ts` 中为 `/ws` 开启代理并设置 `ws: true`，保证 Dev 模式下的 Upgrade 正常透传。
  - 示例：
    ```ts
    // packages/web/vite.config.ts
    export default defineConfig({
      server: {
        port: 5173,
        proxy: {
          '/ws': {
            target: process.env.VITE_API_BASE || 'http://127.0.0.1:3000',
            ws: true,
            changeOrigin: true
          }
        }
      }
    })
    ```

示意代码（精简骨架）：见下方“附：RxJS 客户端骨架”。

## 封装结构与导出（singleton / query-helpers）

目录与文件（前端）：
- `src/lib/ws/rx-client.ts`：底层 RxJS 客户端（提供 `call$`/`notification$`/`subscribeTopic$`）
- `src/lib/ws/singleton.ts`：单例封装，对外统一导出 `ws` 实例（把 `call$` 包装为 `call` 便于调用）
- `src/lib/ws/query-helpers.ts`：WS 优先 + REST 回退的查询辅助（`wsPrefer`），以及错误分类

导出 API（约定；统一签名）：
- `ws.call<T>(method, params, timeoutMs?) => Observable<T>`（底层走 `call$`）
- `ws.first<T>(obs$: Observable<T>) => Promise<T>`
- `ws.subscribeTopic$(topic: 'file'|'tree'|'annotations', filter?: any) => Observable<{ method: string; params: any }>`（自动 subscribe/unsubscribe + 重订阅）
- `ws.notification$(method: string) => Observable<any>`（仅用于 `session.*`/调试低频）
- `ws.enabled: boolean`（由 `VITE_USE_WS` 控制）
- `ws.online$: Observable<boolean>`（连接在线状态，用于 Banner/UI）
- `ws.url: string`（由 `VITE_WS_URL` 或从 `VITE_API_BASE` 推导）
- `ws.state: 'up'|'down'|'connecting'`（连接状态，用于 UI 与熔断判断）
- `wsPrefer(method, params, httpFallback)`：优先 WS、失败回退 REST 的查询辅助
  - 仅在“传输级错误/断线/超时/能力不足（如 MESSAGE_TOO_LARGE）”时回退；业务错误（带 `error.code`）不回退。回退 REST 也可能因 `OVER_LIMIT` 等失败。
  - 用法约束：默认只用于“读取类请求”；写入类仍走 REST，以降低幂等与重入风险（Phase 2 后再评估 WS 写）。

错误约定：
- 统一使用“带 `code` 字段的 Error 对象”（`message` 可为 `CODE:message` 形式）；
- REST 分支通过 `toHttpError` 统一包装为 `Error('CODE:message')` 并附加 `err.code`，便于上层统一判别与提示。

示例实现（singleton）：
```ts
// packages/web/src/lib/ws/singleton.ts
import { WsRxClient } from './rx-client'

function deriveWsUrl(): string {
  const envUrl = (import.meta as any).env?.VITE_WS_URL as string | undefined
  if (envUrl) return envUrl
  const api = (import.meta as any).env?.VITE_API_BASE as string | undefined
  if (api) {
    try {
      const u = new URL(api)
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
      u.pathname = '/ws'
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch {}
  }
  // 同源默认：浏览器当前 origin + /ws
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
}

class WsSingleton {
  private client?: WsRxClient
  enabled = Boolean((import.meta as any).env?.VITE_USE_WS)
  url = deriveWsUrl()
  private ensure() { if (!this.client) this.client = new WsRxClient(this.url); return this.client }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.ensure().call$<T>(method, params, timeoutMs)
  }
  first<T>(obs$: import('rxjs').Observable<T>) { return this.ensure().first<T>(obs$) }
  subscribeTopic$(topic: string, filter: any) { return this.ensure().subscribeTopic$(topic, filter) }
  notification$(method: string) { return this.ensure().notification$(method) }
  get online$() { return this.ensure().online$ }
}

export const ws = new WsSingleton()
```

安装建议（Explorer 页面上下文）：
```ts
// Explorer 页面容器内（如 src/features/explorer/pages/explorer-page.tsx）
import { useExplorerInvalidations } from '@/features/explorer/invalidations'

export default function ExplorerPage(){
  // 安装领域化 WS→Query 失效器（随页面挂载/卸载）
  useExplorerInvalidations()
  // ... 其余页面逻辑
  return <div>...</div>
}
```

示例实现（查询辅助；统一 signal 透传）：
```ts
// packages/web/src/lib/ws/query-helpers.ts
import { http } from '@/lib/request'
import { ws } from './singleton'

const WS_TIMEOUT = 15000
const isTransportError = (e: any) => !e?.code

export async function wsPrefer<T>(
  method: string,
  params: any,
  httpFallback: (signal?: AbortSignal) => Promise<T>,
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  try {
    const ms = opts?.timeoutMs ?? WS_TIMEOUT
    if (!ws.enabled) throw new Error('WS_DISABLED')
    return await ws.first(ws.call<T>(method, params, ms))
  } catch (e: any) {
    if (!isTransportError(e)) throw e // 业务错误（带 code）不回退
    return await httpFallback(opts?.signal) // 传输/断线/超时/能力不足 → 回退 REST
  }
}
```

## 与 React Query 的衔接

### 查询（useQuery）：WS 优先 + REST 回退

- 标准模式：`queryFn` 先尝试 WS；若遇“传输级错误/断线/超时”再回退 REST。对“业务错误”（带有 `error.code` 的响应）不回退，直接抛出。

```ts
// packages/web/src/lib/ws/query-helpers.ts（示意）
import { http } from '@/lib/request'
import { ws } from '@/lib/ws/singleton'

const WS_TIMEOUT = 15000

export async function wsPrefer<T>(
  method: string,
  params: any,
  httpFallback: (signal?: AbortSignal) => Promise<T>,
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  try {
    const ms = opts?.timeoutMs ?? WS_TIMEOUT
    // 先走 WS；注意：WS 抛出的业务错误会附带 e.code，不应回退
    return await ws.first(ws.call<T>(method, params, ms))
  } catch (e: any) {
    if (e?.code) throw e // 业务错误（如 INVALID_PATH/OVER_LIMIT）不回退
    // 传输错误 / 断线 / 超时：回退 REST（透传 signal 以支持取消）
    return await httpFallback(opts?.signal)
  }
}
```

示例 1：文件分页
```ts
import { useQuery } from '@tanstack/react-query'
import { http } from '@/lib/request'
import { wsPrefer } from '@/lib/ws/query-helpers'

export function useFileChunk(path: string, startLine: number, maxLines: number) {
  return useQuery({
    queryKey: ['file', path, startLine, maxLines],
    // React Query v4 的 queryFn 入参含 signal，可传给 axios 用于取消；WS 不支持取消
    queryFn: ({ signal }) =>
      wsPrefer('file.getChunk', { path, startLine, maxLines }, (s) =>
        http.get('/api/file', { params: { path, startLine, maxLines }, signal: s ?? signal }).then((r) => r.data)
      , { signal }),
    staleTime: 30_000,
    gcTime: 5 * 60_000
  })
}
```

示例 2：目录树（Key 含 root 维度）
```ts
export function useTree(dir: string) {
  return useQuery({
    queryKey: ['tree', root, dir], // root 由全局 store 提供（useAppStore.getState().currentRoot）
    queryFn: ({ signal }) =>
      wsPrefer('tree.get', { dir }, (s) =>
        http.get('/api/tree', { params: { dir }, signal: s ?? signal }).then((r) => r.data)
      , { signal }),
    staleTime: 30_000,
    gcTime: 5 * 60_000
  })
}
```

示例 3：批注列表
```ts
export function useAnnotations() {
  return useQuery({
    queryKey: ['annotations'],
    queryFn: ({ signal }) => wsPrefer('annotations.list', {}, (s) => http.get('/api/annotations', { signal: s ?? signal }).then((r) => r.data), { signal }),
    staleTime: 10_000
  })
}
```

要点：
- WS 成功则直接返回；若 WS 抛出带 `code` 的错误（业务错误），保持一致的错误语义交给 UI 处理；仅在“传输故障”时回退 REST。
- 对于 axios 回退分支，将 React Query 提供的 `signal` 透传以支持取消，避免组件卸载后仍占用资源。
- 事件推送仍会驱动缓存失效或直改缓存（见下文“推送驱动”），确保“读取一次 + 推送维持实时”。

### 写入（useMutation）：默认 REST，写后广播

- 保存文件与批注 CRUD 默认走 REST；WS 写方法可作为可选实现。
```ts
import { useMutation } from '@tanstack/react-query'
import { http } from '@/lib/request'

export function useSaveFile() {
  return useMutation({
    mutationFn: (body: { path: string; content: string; baseDigest?: string }) =>
      http.put('/api/file', body).then((r) => r.data),
    onSuccess: () => {
      // 无需手动失效：服务端写后会广播 file.changed/annotations.*，由订阅处理
    }
  })
}
```

### 推送驱动：失效或直改缓存

- `file.changed` 命中当前 `path`：失效 `['file', path, ...]`；若编辑中，提示冲突/刷新
- `tree.changed`：
  - 未截断（带 `impactedPaths` 且 `truncated=false`）：计算最小目录集合，逐一 `invalidateQueries(['tree', currentRoot, dir])`
  - 截断（`truncated=true`）或未携带 `impactedPaths`：失效当前视图根（`['tree', currentRoot, currentDir]`）或必要时失效全局
- `annotations.created|updated|deleted`：失效 `['annotations']` 或直接合并更新缓存
- `annotations.verify.done`：对结果中 `updatedIds/deletedIds` 影响的 UI 做提示/刷新

建议准则：
- 轻量资源（批注）采用“推数据直改缓存”；重资源（文件/目录）采用“推事件触发精确失效”。
- 事件可能合并/截断（`summary.truncated`），前端应容忍并在必要时主动 refetch。

## 领域化事件→缓存失效（invalidators）

- 目标：将事件→查询 Key 的策略“按领域拆分”，由特性页面在挂载时安装，降低全局耦合。
- 文件：
  - `packages/web/src/features/explorer/ws-invalidators/file-invalidator.ts`
  - `packages/web/src/features/explorer/ws-invalidators/tree-invalidator.ts`
  - `packages/web/src/features/explorer/ws-invalidators/annotations-invalidator.ts`
  - 聚合安装：`packages/web/src/features/explorer/invalidations.ts`
- 要点：
  - RAF 合批与去重：合并同一帧内的多次 `invalidateQueries`；按路径/digest 短窗去重。
  - 策略：
    - `file.changed` → 失效 `['file', path]`，并失效该文件所属目录树项
    - `tree.changed` 未截断 → `calcMinimalDirs(impactedPaths)` 后逐一失效 `['tree', currentRoot, dir]`；截断/缺省 → 失效当前视图根
    - `annotations.*` → 直改 `['annotations']` 列表或整表失效（`verify.done`）

集成：在 Explorer 页面调用 `useExplorerInvalidations()` 即可完成安装（从 store 注入 `currentRoot/currentDir`）。

## 订阅由 UI 状态驱动（Explorer 订阅桥）

- 目标：仅订阅“当前可见视图”所需主题，降低推送面与渲染频率。
- 文件：`packages/web/src/features/explorer/subscriptions.ts`
- 策略：
  - 文件编辑器打开某 `path` → 订阅 `file:{ path }`
  - 文件树浏览 `currentDir` → 订阅 `tree:{ dir: currentDir }`
  - 批注面板可见 → 订阅 `annotations{}`（可按 `filePath` 过滤）
- 生命周期：组件 mount→subscribe，unmount→unsubscribe；目录/文件切换时切换订阅。

示例骨架（仅维护订阅，事件处理交由中心化 invalidator）：
```ts
import { useEffect } from 'react'
import { ws } from '@/lib/ws/singleton'
import { useAppStore } from '@/stores/app'

export function useWsSubscriptions() {
  const { currentDir, selectedPath, activePane } = useAppStore()
  useEffect(() => {
    if (!ws.enabled) return
    // 通过订阅主题让服务端预过滤推送；此处仅维持订阅，不直接处理事件
    const subs: Array<import('rxjs').Subscription> = []
    subs.push(ws.subscribeTopic$('tree', { dir: currentDir }).subscribe())
    if (selectedPath) subs.push(ws.subscribeTopic$('file', { path: selectedPath }).subscribe())
    if (activePane === 'annotations') subs.push(ws.subscribeTopic$('annotations', {}).subscribe())
    return () => { subs.forEach(s => s.unsubscribe()) }
  }, [currentDir, selectedPath, activePane])
}
```

## wsPrefer 熔断/退避与取消

- 回退触发的错误类型（可回退）：
  - 连接未建立/断线（`ws.state!=='up'`）、请求超时、帧解析失败、底层发送失败、`MESSAGE_TOO_LARGE`（能力不足）。
  - 业务错误（含 `error.code` 且非能力不足类）不回退，直接抛出交由 UI 处理。
- 熔断：当 WS 连接 down 或连续 N 次（建议 N=3）出现上述回退类错误，进入短窗口（如 10s）优先 REST，仅做周期性单次 WS 探测以恢复；窗口结束或探测成功自动退出熔断。
- 取消：`wsPrefer` 支持 `AbortSignal`，取消时通过 `takeUntil(fromEvent(signal,'abort'))` 终止 Observable（WS 侧请求不可真正取消，仅丢弃响应）。
- 建议签名：`wsPrefer<T>(method, params, httpFallback: (signal?: AbortSignal)=>Promise<T>, opts?: { timeoutMs?: number; signal?: AbortSignal })`

## 事件顺序与去重

- 同一路径/资源在短窗口内若既收到“写后广播（通常带 `digest`）”，又收到“监听推送（无 digest）”，以“带 `digest` 的事件”为准；对随后同 key 的监听事件执行忽略或降权处理（由中心化 invalidator 负责）。
- 推送事件可能合并/截断（`summary.truncated`）；当被截断时按粗粒度刷新策略处理（当前视图根/必要时全局）。

## 错误与状态 UI

- JSON-RPC 错误统一映射为 `{ error:{ code,message } }`，沿用 REST 错误处理与 toast 映射。
- 导出连接状态：`ws.state: 'up'|'down'|'connecting'`；在 UI 做轻量状态点/tooltip 提示；`down` 时减少重复错误提示。

## 类型与运行时校验

- 类型：`packages/web/src/lib/ws/types.ts` 定义 `JsonRpcEnvelope`、`FileChangedEvent`、`TreeChangedEvent`、`AnnotationEvents`、方法参数/返回类型。
- 运行时：`packages/web/src/lib/ws/validators.ts` 使用 Zod 对入站事件做轻校验（开发环境启用），防御脏数据污染缓存。
- 与现有类型对齐：统一 `DirEntry['type']` 为 `'file'|'dir'`。

## 调试与 Mock

- `VITE_WS_DEBUG=1`：打印连接/请求/事件摘要（可控开关）。
- `mockWsClient`（可选）：在无后端 WS 时模拟基本通知流和读取响应，便于前端先行验证订阅与失效链路。

## 前端实现清单（落地对照）

- `src/lib/ws/rx-client.ts`：连接/重连/心跳/请求-响应匹配/subscribeTopic$
- `src/lib/ws/singleton.ts`：实例、URL 推导、`enabled/state` 暴露
- `src/lib/ws/query-helpers.ts`：`wsPrefer`（含熔断与取消）
- `src/features/explorer/ws-invalidators/*`：领域化事件→Key 映射与批处理（聚合于 `features/explorer/invalidations.ts`）
- `src/features/explorer/subscriptions.ts`：订阅绑定 Explorer UI 状态
- Explorer API：`fetchTree/fetchFile*`、`listAnnotations` 采用 `wsPrefer`
- Explorer 页面安装：`useExplorerInvalidations()`；Vite 代理 `/ws`（开发）

## 多实例与注册表（Registry/Factory）（可选，非本阶段）

场景：当前默认单连接满足需求，但未来可能按“域/QoS/服务”拆分多个专职连接（如 `default`/`fs`/`stitch`）。为避免后期大改，建议从一开始就以“注册表 + 工厂”组织，可随时新增专职连接。

目标与约束：
- 惰性创建：首次使用才建连；无订阅/调用不消耗资源。
- 单例语义：同名连接全局唯一，跨模块共享；支持引用计数/闲时释放（可选）。
- 可多实例：按 `name/url/profile` 创建独立连接，互不影响。
- HMR 安全：Vite 开发热更不重复建连（全局持久化注册表）。
- 演进方式：默认使用 `default` 连接；未来需要拆分时只需在调用处透传 `wsName` 或在注册表路由表中配置即可。

文件与职责：
- `src/lib/ws/connection.ts`（WebSocket 连接实现类，建议命名 `WsRxClient`）
  - 连接/重连（指数退避+抖动）、心跳、请求配对、订阅/退订、订阅恢复、传输错误分类、`state: 'up'|'down'|'connecting'`、`VITE_WS_DEBUG` 日志。
- `src/lib/ws/registry.ts`
  - 全局注册表：`Map<string, { client: WsRxClient, refs: number }>`；`ensure(name, opts)`、`get(name)`、`release(name)`、`routeTopic(methodOrTopic): name`。
  - HMR 安全：基于 `globalThis.__AILOOM_WS_REGISTRY__` 或 `import.meta.hot?.data` 持久化。
- `src/lib/ws/singleton.ts`
  - 提供默认命名连接访问器：`ws = ensure('default')`；并导出 `getWs(name)`/`releaseWs(name)` 便于模块化拆分。
- `src/lib/ws/query-helpers.ts`
  - `wsPrefer(method, params, httpFallback, { timeoutMs, signal, wsName='default' })`：支持选择连接名；结合熔断门仅在“传输错误”回退 REST。

骨架示例：
```ts
// packages/web/src/lib/ws/registry.ts
// 说明：本模块在 Phase 3 才会引入；Phase 1 仅保留 singleton。
import { WsRxClient } from './rx-client'

type Cfg = { url?: string }
type Entry = { client: WsRxClient; refs: number }

const g = globalThis as any
const REG_KEY = '__AILOOM_WS_REGISTRY__'
if (!g[REG_KEY]) g[REG_KEY] = new Map<string, Entry>()
const REG: Map<string, Entry> = g[REG_KEY]

export function ensure(name = 'default', cfg?: Cfg): WsRxClient {
  const e = REG.get(name)
  if (e) { e.refs++; return e.client }
  const url = deriveUrl(cfg?.url) // 复用 singleton 的 URL 推导
  const client = new WsRxClient({ url, name })
  REG.set(name, { client, refs: 1 })
  return client
}

export function release(name = 'default') {
  const e = REG.get(name)
  if (!e) return
  e.refs = Math.max(0, e.refs - 1)
  // 可选：当 refs=0 时延迟关闭连接（如 idle 30s）
}

export function get(name = 'default'): WsRxClient | undefined { return REG.get(name)?.client }

export function routeTopic(methodOrTopic: string): string {
  // 默认全部走 default；未来可按需把 stitch.* 路由到 'stitch' 等
  return 'default'
}
```

```ts
// packages/web/src/lib/ws/singleton.ts（默认连接访问器）
import { ensure, get } from './registry'

export const ws = ensure('default')
export function getWs(name = 'default') { return ensure(name) }
```

```ts
// packages/web/src/lib/ws/query-helpers.ts（选择连接）
import { getWs } from './singleton'

export async function wsPrefer<T>(method: string, params: any, httpFallback: (s?: AbortSignal)=>Promise<T>, opts?: { timeoutMs?: number; signal?: AbortSignal; wsName?: string }): Promise<T> {
  const { timeoutMs = 15000, signal, wsName = 'default' } = opts || {}
  const client = getWs(wsName)
  if (!client?.enabled) return httpFallback(signal)
  try {
    return await client.call<T>(method, params, { timeoutMs, signal })
  } catch (e: any) {
    if (isTransportError(e)) return await httpFallback(signal)
    throw e // 业务错误不回退
  }
}
```

使用建议：
- 默认继续用 `default` 连接；当需要将某域切换到专职连接时，只需：
  - 在调用侧传 `{ wsName:'fs' }` 或在 `routeTopic` 中配置映射；
  - 在启动时 `ensure('fs', { url: deriveUrlForFs() })` 即可。
- 订阅 Hook `useWsSubscriptions()` 也可接受 `wsName`，按域拆分订阅与事件面。
## 断线/重连与订阅恢复

- 自动重连采用指数退避（初始 500ms，上限 5s，含抖动），连接恢复后：
  - 自动重放 `subscribe`（持久化在内存，必要时与 Zustand 协作）
  - 触发一次轻量自检（如 `session.health` 或拉取关键查询）以消除重连窗口的错过事件

## 错误映射与提示

- 与 REST 保持一致：
  - `NON_TEXT/OVER_LIMIT/CONFLICT/HTTP_xxx/NETWORK` → 统一为 `code:message` 的 Error 实例
  - `CONFLICT` 保持携带 `currentDigest` 语义
  - 回退策略：WS 调用失败时（网络/断线/超时），前端可透明回退 REST 读取；写入失败按现有 REST 分支处理

## 进阶与优化（后续）

- 增加流式/分片方法（减少大文件单帧大小与首屏时间）
- 引入 MessagePack 编解码（可配置开关）
- 与 Monaco 编辑器联动，基于 `file.changed` 做更细粒度提示/自动合并（可选）

## 与社区最佳实践对齐（TanStack Query × WebSocket）

要点（吸纳并落地到本方案）：
- Query 中立于传输：初次 useQuery 正常拉取；WS 仅作为“事件通道”，通过 `invalidateQueries` 或 `setQueryData` 维持实时。
- 事件形态建议：优先“失效标签/Key 映射”（更轻），按需“数据补丁”（更快）；大对象优先失效+重拉避免复杂合并。
- 新鲜度策略：
  - 推送为主（强实时）：为相关查询提高 `staleTime`（可至 Infinity），并关闭 `refetchOnWindowFocus/refetchOnReconnect`。
  - 推送为辅（提醒）：保持默认 `staleTime`，事件只做失效触发拉取，更稳妥。
- 性能与稳定：
  - 将多次 `setQueryData` 合并到 `requestAnimationFrame` 或微队列；结构共享避免深拷贝。
  - 高频路径优先采用“失效+重拉”替代补丁，避免渲染抖动。
- 乐观与对账：mutation 的 `onMutate` 做乐观更新；以服务端推送“拍扁最终状态”。担心“双写”则仅失效，交给服务端消息收敛。
- 订阅范围：只订阅“当前激活视图”对应频道；组件卸载时取消订阅，降低推送面。
- 断线补偿：若事件带 `lastEventId/version/updatedAt`，重连用“从序号增量补齐”；否则对相关 Key 做一次全量失效对齐。
- 安全：握手附带 token（子协议/查询串），服务端分频道隔离租户/用户，避免越权广播。

### QueryClient 默认项（两种模式）

```ts
// 推送为主（强实时）：提高 staleTime，关闭自动拉取
const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 0
    }
  }
})

// 推送为辅（提醒）：保持默认，事件只做失效即可
const qc = new QueryClient({
  defaultOptions: { queries: { retry: 0 } }
})
```

### 泛化事件同步（useWsQuerySync：失效 + 可选补丁）

```ts
// src/lib/ws/ws-query-sync.ts（可选：与 rx-client/singleton 协作；需服务端提供聚合 topic 'query-sync' 才可用）
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ws } from '@/lib/ws/singleton'

type InvalidateEvt = { type: 'invalidate'; key: readonly unknown[] }
type PatchEvt = { type: 'patch'; key: readonly unknown[]; payload: any }
type ServerEvt = InvalidateEvt | PatchEvt

export function useWsQuerySync() {
  const qc = useQueryClient()
  useEffect(() => {
    const sub = ws.subscribeTopic$('query-sync').subscribe((n) => {
      const msg = n.params as ServerEvt
      if (msg.type === 'invalidate') {
        qc.invalidateQueries({ queryKey: msg.key })
      } else if (msg.type === 'patch') {
        // 按需 upsert；避免深拷贝
        qc.setQueriesData({ queryKey: msg.key }, (old: any) => {
          if (Array.isArray(old) && msg.payload?.id != null) {
            const i = old.findIndex((x: any) => x.id === msg.payload.id)
            if (i >= 0) return [...old.slice(0, i), { ...old[i], ...msg.payload }, ...old.slice(i + 1)]
            return [msg.payload, ...old]
          }
          return { ...old, ...msg.payload }
        })
      }
    })
    return () => sub.unsubscribe()
  }, [qc])
}
```

微弹码（补充）：
- 以上示例依赖可选扩展 topic `query-sync`；若服务端未实现该聚合通道，请勿启用此 Hook（或改为按具体业务 topic 订阅并自行映射）。
- 在高频事件路径，使用 `requestAnimationFrame(() => { batched setQueryData })` 或微任务 `Promise.resolve().then(...)` 合并多次更新。
- `setQueriesData` 支持按 `keyPrefix` 批量匹配（如 `['posts']`），便于对列表/详情合并补丁；大范围仍建议失效。
- 断线补偿接口（前端约定）：在 `session.welcome` 或首帧后保存 `lastEventId`；重连后发送 `{ method:'events.resume', params:{ after:lastEventId } }` 获取增量，若失败则失效对应 key（示意，需后端配合）。

## 使用 observable-hooks 集成 RxJS（推荐）

依赖：`observable-hooks`（与 `rxjs` 一起使用）。优势：订阅声明式、自动清理、依赖驱动重建，减少手写 useEffect/cleanup 的陷阱。

常用 Hook
- `useSubscription(() => observable$, next, deps)`：订阅产生副作用（如 invalidate/setQueryData）。
- `useObservableState(() => observable$, initial)`：把 Observable 映射为组件本地状态（UI 展示）。
- `useEventCallback(eventHandler)`：将组件事件转为 Observable 管道（本方案可选）。

示例 1：annotations.* 直改缓存（useSubscription，按 topic 订阅后在流内按 method 过滤）
```tsx
import { useSubscription } from 'observable-hooks'
import { map } from 'rxjs/operators'

const ann$ = useMemo(() =>
  ws
    .subscribeTopic$('annotations')
    .pipe(map(n => ({ method: n.method, payload: n.params }))),
  []
)

useSubscription(ann$, ({ method, payload }) => {
  if (method === 'annotations.deleted') {
    qc.setQueryData<Annotation[]>(['annotations'], (old=[]) => old.filter(a => a.id !== payload.id))
  } else {
    const a = payload.annotation as Annotation
    qc.setQueryData<Annotation[]>(['annotations'], (old=[]) => {
      const i = old.findIndex(x => x.id === a.id)
      if (i < 0) return [...old, a]
      const cp = old.slice(); cp[i] = a; return cp
    })
  }
})
```

示例 2：file.changed 精确失效当前文件（useSubscription，依赖通过闭包获取）
```tsx
import { useSubscription } from 'observable-hooks'
import { map } from 'rxjs/operators'

const fileChanged$ = useMemo(() => ws
  .subscribeTopic$('file', selectedPath ? { path: selectedPath } : {})
  .pipe(map(n => n.params as FileChangedEvent)), [selectedPath])

useSubscription(fileChanged$, (e) => {
  if (currentFile && (e.path === currentFile || e.fromPath === currentFile)) {
    qc.invalidateQueries({ queryKey: ['file', currentFile] })
  }
})
```

示例 3：tree.changed impactedPaths 精确/粗粒度失效（useSubscription + 合并）
```tsx
import { useSubscription } from 'observable-hooks'
import { bufferTime, map } from 'rxjs/operators'

const calcAffectedDirs = (paths: string[]) => {
  const dirs = Array.from(new Set(paths.map(p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')))
  dirs.sort((a,b)=> a.length-b.length)
  const res:string[]=[]; for(const d of dirs){ if(!res.some(x=> d===x || d.startsWith(x+'/'))) res.push(d) } return res
}

const treeChanged$ = useMemo(() =>
  ws
    .subscribeTopic$('tree', {})
    .pipe(
      map(n => n.params as TreeChangedEvent),
      bufferTime(300),
      map(batch => {
        const dirs = new Set<string>(); let coarse=false
        for (const e of batch) {
          if (!e) continue
          const list = e.impactedPaths || []
          const truncated = e.summary?.truncated || list.length===0
          if (truncated) { coarse = true; continue }
          calcAffectedDirs(list).forEach(d => dirs.add(d))
        }
        return { dirs: Array.from(dirs), coarse }
      })
    ),
  []
)

useSubscription(treeChanged$, ({ dirs, coarse }) => {
  const root = useAppStore.getState().currentRoot || ''
  if (coarse) { qc.invalidateQueries({ queryKey: ['tree', root, currentDir || '.'], exact: false }) }
  dirs.forEach(d => qc.invalidateQueries({ queryKey: ['tree', root, d], exact: true }))
})
```

示例 4：将 Observable 直接作为 UI 状态（useObservableState）
```tsx
import { useObservableState } from 'observable-hooks'
import { scan, startWith } from 'rxjs/operators'

// 把最近 20 条 annotations.created 事件展示在页面（仅 UI，非全局缓存）
const recent = useObservableState<string[]>(() =>
  ws.subscribeTopic$('annotations', {}).pipe(
    filter(x => x.method === 'annotations.created'),
    map(x => (x.params?.annotation?.id as string) || ''),
    scan((acc, id) => [id, ...acc].slice(0, 20), [] as string[]),
    startWith([] as string[])
  ),
  []
)
```

注意事项（微弹码）
- useSubscription 只适合“副作用型”处理（invalidate/setQueryData/Toast 等）；需要作为 UI 值时用 useObservableState。
- 依赖数组必须包含用于构建 Observable 的外部变量（如 currentDir/currentFile），确保切换视图时重建订阅。
- 对高频流组合 `bufferTime`/`auditTime`/`throttleTime`；必要时在回调里批量调用 `queryClient` API。
- 若多个组件使用同一高频流，建议在 rx-client/singleton 层为该流 `shareReplay(1)`，避免重复开销。

### 用 useObservable 构建“依赖驱动”的流（推荐模式）

当订阅需要依赖外部变量（如当前目录/文件）时，优先用 `useObservable` 生成稳定且依赖驱动的 Observable，再交给 `useSubscription` 或 `useObservableState`。

示例：仅当 currentFile 变更时重建 file.changed 过滤流
```tsx
import { useObservable } from 'observable-hooks'
import { filter, map, switchMap } from 'rxjs/operators'

// inputs$: Observable<[currentFile]>
const fileHits$ = useObservable(([file$]) =>
  file$.pipe(
    switchMap((cur) => ws
      .subscribeTopic$('file', {})
      .pipe(
        map(n => n.params as FileChangedEvent),
        filter(e => !!cur && (e.path === cur || e.fromPath === cur))
      )
    )
  ),
  [currentFile]
)

useSubscription(fileHits$, () => {
  if (currentFile) qc.invalidateQueries({ queryKey: ['file', currentFile] })
})
```

示例：目录流 + 合并 — 视图切换时自动重建
```tsx
import { useObservable } from 'observable-hooks'
import { bufferTime, map, switchMap } from 'rxjs/operators'

const treeBatch$ = useObservable(([dir$]) =>
  dir$.pipe(
    switchMap((dir) => ws
      .subscribeTopic$('tree', { dir }) // 服务端可按 dir 预过滤；前端仍需校验
      .pipe(
        map(n => n.params as TreeChangedEvent),
        bufferTime(300),
        map(batch => ({ dir, batch }))
      )
    )
  ),
  [currentDir]
)

useSubscription(treeBatch$, ({ dir, batch }) => {
  const dirs = new Set<string>(); let coarse = false
  for (const e of batch) {
    if (!e) continue
    const list = e.impactedPaths || []
    const truncated = e.summary?.truncated || list.length === 0
    if (truncated) { coarse = true; continue }
    calcAffectedDirs(list).forEach(d => dirs.add(d))
  }
  const root = useAppStore.getState().currentRoot || ''
  if (coarse) qc.invalidateQueries({ queryKey: ['tree', root, dir || '.'], exact: false })
  dirs.forEach(d => qc.invalidateQueries({ queryKey: ['tree', root, d], exact: true }))
})
```

### 用 useObservableState 获取 UI 状态（避免额外 store）

当只是为了 UI 展示而订阅流，不需要进全局缓存时，建议用 `useObservableState` 直接落到本地 state。

示例：最近创建的 20 个批注 ID 列表
```tsx
import { useObservableState } from 'observable-hooks'
import { map, scan, startWith } from 'rxjs/operators'

const recentCreated = useObservableState<string[]>(() =>
  ws.subscribeTopic$('annotations', {}).pipe(
    filter(x => x.method === 'annotations.created'),
    map(x => (x.params?.annotation?.id as string) || ''),
    scan((acc, id) => id ? [id, ...acc].slice(0, 20) : acc, [] as string[]),
    startWith([] as string[])
  ),
  []
)
```

### 用 useObservableCallback 将组件事件转为流（可选）

```tsx
import { useObservableCallback } from 'observable-hooks'
import { debounceTime, filter, map, switchMap } from 'rxjs/operators'

// 搜索框：合并输入，触发 WS 查询
const [onInput, results$] = useObservableCallback<string, string[]>(
  (input$, _init) => input$.pipe(
    map(e => (e as unknown as React.ChangeEvent<HTMLInputElement>).target.value),
    debounceTime(250),
    filter(q => q.length >= 2),
    switchMap(q => ws.call<string[]>('search.query', { q }))
  )
)

const suggestions = useObservableState(results$, [])
return <input onChange={onInput} />
```

## 错误统一与 UI 兜底（推荐约定）

统一错误形态
- 业务错误：始终抛出“带 `code` 的 Error”（如 `INVALID_PATH`、`OVER_LIMIT`、`CONFLICT`）。
- 传输错误：归一为 `Error('NETWORK:...')` 或包含 `code='MESSAGE_TOO_LARGE'` 等能力错误；
- Axios 回退：用 `toHttpError` 包装为“带 `code` 的 Error”；无响应一律视为 `NETWORK`。

UI 兜底策略
- 顶部 Banner：当 `ws.enabled=false` 时显示“离线/重连中”的轻提示；恢复后自动消失。
- 错误提示：对 `NETWORK` 提示“网络问题，请稍后重试”；对业务错误按 code 文案化（如 `OVER_LIMIT`/`CONFLICT`）。
- 重试入口：为关键视图提供显式“刷新/重试”按钮（调用 `queryClient.invalidateQueries`）。

片段：WS 连接 Banner（observable-hooks）
```tsx
import { useObservableState } from 'observable-hooks'
import { ws } from '@/lib/ws/singleton'

export function WsBanner() {
  const online = useObservableState(() => ws.online$, true)
  if (online) return null
  return (
    <div className="fixed top-0 left-0 right-0 bg-amber-100 text-amber-900 text-sm py-1 text-center">
      正在重连到实时服务…（离线模式下使用 REST 兜底）
    </div>
  )
}
```

片段：错误规范化（回退 + 统一）
```ts
// src/lib/ws/query-helpers.ts（要点）
import { AxiosError } from 'axios'

export function toHttpError(e: unknown) {
  const ax = e as AxiosError<{ error?: { code?: string; message?: string } }>
  const code = ax.response?.data?.error?.code || (ax.code === 'ERR_NETWORK' ? 'NETWORK' : 'HTTP_ERROR')
  const message = ax.response?.data?.error?.message || ax.message || 'HTTP Error'
  const err: any = new Error(`${code}:${message}`)
  err.code = code
  return err
}

const isTransportError = (e: unknown) => e instanceof Error && /WS_|Timeout|socket|NETWORK|MESSAGE_TOO_LARGE/i.test(e.message)

export async function wsPrefer<T>(method: string, params: unknown, httpFallback: (signal?: AbortSignal)=>Promise<T>, opts?:{ timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
  try {
    if ((import.meta.env.VITE_USE_WS ?? '1') !== '0' && ws.enabled) {
      return await ws.first(ws.call<T>(method, params, opts?.timeoutMs ?? 15000))
    }
  } catch (e) {
    if (!isTransportError(e)) throw e // 业务错误不回退
    // 传输/能力错误 → 尝试 REST；如 REST 也失败则抛 toHttpError（含 NETWORK/HTTP_XXX）
  }
  try { return await httpFallback(opts?.signal) } catch (e) { throw toHttpError(e) }
}
```

## 热点通知流 shareReplay(1)（复用与降开销）

目的：多个组件订阅同一高频事件时，避免重复解析与多次副作用；在 ws/singleton 层缓存带 `shareReplay(1)` 的热点流。

片段：在单例中缓存热点流
```ts
// src/lib/ws/hot-topics.ts（示例）
import { map, shareReplay } from 'rxjs/operators'
import { ws } from './singleton'
import type { FileChangedEvent, TreeChangedEvent } from '@/types/domain'

const cache = new Map<string, any>()
function hot<T>(key: string, factory: () => import('rxjs').Observable<T>) {
  const ex = cache.get(key); if (ex) return ex as import('rxjs').Observable<T>
  const obs$ = factory().pipe(shareReplay({ bufferSize: 1, refCount: true }))
  cache.set(key, obs$); return obs$
}

export const fileChanged$ = () => hot<FileChangedEvent>('file.changed', () => ws.subscribeTopic$('file', {}).pipe(map(n => n.params as FileChangedEvent)))
export const treeChanged$ = () => hot<TreeChangedEvent>('tree.changed', () => ws.subscribeTopic$('tree', {}).pipe(map(n => n.params as TreeChangedEvent)))
```

组件侧使用（observable-hooks）
```tsx
import { useSubscription } from 'observable-hooks'
import { fileChanged$, treeChanged$ } from '@/lib/ws/hot-topics'

useSubscription(() => fileChanged$(), (e) => {
  if (e.path === currentFile || e.fromPath === currentFile) qc.invalidateQueries({ queryKey: ['file', currentFile!] })
}, [qc, currentFile])

useSubscription(() => treeChanged$(), ({ impactedPaths = [], summary }) => {
  const truncated = !!summary?.truncated
  if (!truncated && impactedPaths.length) {
    const root = useAppStore.getState().currentRoot || ''
    calcAffectedDirs(impactedPaths).forEach(d => qc.invalidateQueries({ queryKey: ['tree', root, d] }))
  } else {
    const root = useAppStore.getState().currentRoot || ''
    qc.invalidateQueries({ queryKey: ['tree', root, currentDir || '.'] })
  }
}, [qc, currentDir])
```

## 领域类型与事件载荷（前端定义示例）

```ts
// src/types/domain.ts（示例）
export interface DirEntry { name: string; path: string; type: 'file'|'dir'; size?: number; mtime?: string }
export interface FileChunk { path: string; startLine: number; endLine: number; totalLines: number; content: string; truncated: boolean; digest?: string }
export interface Annotation { id: string; filePath: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number; selectedText: string; comment: string; tags?: string[]; priority?: 'P0'|'P1'|'P2'; createdAt: string; updatedAt: string }
export interface VerifyResultOut { checked: number; updated: number; deleted: number; skipped: number; updatedIds: string[]; deletedIds: string[]; skippedIds: string[] }
export interface FileChangedEvent { path: string; kind: 'created'|'modified'|'deleted'|'moved'; fromPath?: string; digest?: string; ts: string }
export interface TreeChangedEvent { dir?: string; impactedPaths?: string[]; summary?: { created: number; modified: number; deleted: number; moved: number; truncated: boolean }; ts: string }
```

## 订阅挂载（App 桥接）

```tsx
// src/App.tsx（节选）
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useExplorerSubscriptions } from '@/features/explorer/subscriptions'

const qc = new QueryClient()
function SubscriptionsBridge(){ useExplorerSubscriptions(); return null }

export default function App(){
  return (
    <QueryClientProvider client={qc}>
      <SubscriptionsBridge />
      {/* ...Routes */}
    </QueryClientProvider>
  )
}
```

## 行为约束与 Gotchas（observable-hooks × RxJS）

- useSubscription
  - 仅接收 Observable 或 Observer 对象，不接收依赖数组；当传入的 Observable 引用变化时自动退订/重订阅。
  - 回调是“最新闭包安全”的；但不要在回调里做重型同步工作（尽量把计算放到流内或批量到下一帧）。
- useObservable / useLayoutObservable
  - init(inputs$) 模式中，不要直接闭包读取外部变量；把外部变量放进依赖数组，由 hooks 传入 inputs$。
  - 依赖数组长度必须固定；不要在条件分支中改变依赖数量。
  - 仅在需要“渲染前拿到值”时用 useLayoutObservable，避免阻塞渲染。
- useObservableState / useObservableEagerState
  - 前者订阅发生在渲染提交后（异步）；后者适用于 BehaviorSubject/热流需要“首帧同步值”的场景，但会二次订阅（谨慎用于冷流）。
- 错误处理
  - RxJS 流一旦 error 即终止；在分支上用 catchError/RetryWhen 兜底，或将 observable 本身作为状态进行替代。
- 性能
  - 高频流优先合并（bufferTime/auditTime/throttleTime）；热点流 shareReplay(1) 后在组件层复用。
  - 对 TanStack Query 的多次 setQueryData/invalidateQueries 合批（raf/微任务），减少渲染抖动。

## Marble 测试建议（RxJS 流验证）

推荐使用 rxjs/testing 的 TestScheduler 或社区工具（如 marble 测试 helpers）验证“合并/节流/过滤”的时序正确性。

示例：tree.changed 合并 300ms 后输出最小目录集合
```ts
import { TestScheduler } from 'rxjs/testing'
import { of } from 'rxjs'
import { bufferTime, map } from 'rxjs/operators'

const calcAffectedDirs = (paths: string[]) => {/* 同文档实现 */[] as string[]}

describe('tree.changed batching', () => {
  it('batches events within 300ms and maps to minimal dirs', () => {
    const ts = new TestScheduler((a, e) => expect(a).toEqual(e))
    ts.run(({ cold, expectObservable }) => {
      const src = cold('a 100ms b 100ms c|', {
        a: { impactedPaths: ['a/b.txt'], summary: {} },
        b: { impactedPaths: ['a/c.txt'], summary: {} },
        c: { impactedPaths: ['a/d/e.txt'], summary: {} }
      })
      const out$ = src.pipe(
        bufferTime(300),
        map(batch => ({
          dirs: Array.from(new Set(batch.flatMap(e => calcAffectedDirs(e.impactedPaths || []))))
        }))
      )
      expectObservable(out$).toBe('300ms (x|)', { x: { dirs: ['a'] } })
    })
  })
})
```

## 顶层 API 聚合（可选）

```ts
// src/features/explorer/api/index.ts（示例）
import { http, wsPrefer } from '@/lib/ws/query-helpers'
import type { DirEntry, FileChunk, Annotation } from '@/types/domain'

export const api = {
  tree: {
    get: (dir: string, signal?: AbortSignal) => wsPrefer<DirEntry[]>('tree.get', { dir }, (s)=> http.get('/api/tree', { params:{ dir }, signal:s }).then(r=>r.data))
  },
  file: {
    getChunk: (p: { path: string; startLine: number; maxLines: number }, signal?: AbortSignal) =>
      wsPrefer<FileChunk>('file.getChunk', p, (s)=> http.get('/api/file', { params:p, signal:s }).then(r=>r.data)),
    getFull: (path: string, signal?: AbortSignal) =>
      wsPrefer<string>('file.getFull', { path }, (s)=> http.get('/api/file/full', { params:{ path }, signal:s }).then(r=>r.data)),
    save: (payload: { path: string; content: string; baseDigest?: string }) => http.put('/api/file', payload).then(r=>r.data)
  },
  annotations: {
    list: (signal?: AbortSignal) => wsPrefer<Annotation[]>('annotations.list', {}, (s)=> http.get('/api/annotations', { signal:s }).then(r=>r.data)),
    create: (a: any) => http.post('/api/annotations', a).then(r=>r.data),
    update: (a: any) => http.put(`/api/annotations/${a.id}`, a).then(r=>r.data),
    delete: (id: string) => http.delete(`/api/annotations/${id}`).then(r=>r.data),
  }
}
```

## 附：RxJS 客户端骨架（示意）

```ts
// packages/web/src/lib/ws/rx-client.ts（节选）
import { webSocket } from 'rxjs/webSocket'
import { Observable, Subject, BehaviorSubject, share, filter, take, timeout, switchMap, of, throwError, firstValueFrom, map, defer, finalize, tap, timer, takeUntil, merge, EMPTY } from 'rxjs'

type RpcReq = { jsonrpc:'2.0'; id:string; method:string; params?:any }
type RpcRes = { jsonrpc:'2.0'; id:string; result?:any; error?:{ code:string; message:string; data?:any } }
type RpcNt = { jsonrpc:'2.0'; method:string; params?:any }
type RpcMsg = RpcReq | RpcRes | RpcNt

const genId = (() => { let n=0; return () => `${Date.now().toString(36)}-${(++n).toString(36)}` })()

export class WsRxClient {
  private url: string
  private ws$ = webSocket<RpcMsg>({ url: '', serializer: v => JSON.stringify(v), deserializer: e => JSON.parse((e as MessageEvent).data) })
  private inbound$!: Observable<RpcMsg>
  private stop$ = new Subject<void>()
  private closed$ = new Subject<void>()
  public online$ = new BehaviorSubject<boolean>(false)

  constructor(url: string) { this.url = url; this.reconnect() }

  private reconnect() {
    this.ws$ = webSocket<RpcMsg>({
      url: this.url,
      serializer: v => JSON.stringify(v),
      deserializer: e => JSON.parse((e as MessageEvent).data),
      openObserver: { next: () => this.online$.next(true) },
      closeObserver: { next: () => { this.online$.next(false); this.closed$.next() } }
    })
    this.inbound$ = this.ws$.pipe(
      tap((m) => {
        if ((m as any).method === 'session.ping') {
          const ts = (m as any)?.params?.ts
          this.ws$.next({ jsonrpc: '2.0', method: 'session.pong', params: { ts } } as any)
        }
      }),
      share()
    )
    this.closed$.pipe(
      takeUntil(this.stop$),
      switchMap((_, i) => timer(Math.min(500 * Math.pow(2, i), 5000))),
      tap(() => this.reconnect())
    ).subscribe()
  }

  call$<T>(method: string, params?: any, ms=15000): Observable<T> {
    const id = genId(); this.ws$.next({ jsonrpc:'2.0', id, method, params })
    return this.inbound$.pipe(
      filter((m): m is RpcRes => (m as any).id === id), take(1), timeout({ each: ms }),
      switchMap((m) => m.error ? throwError(()=> Object.assign(new Error(m.error.code+':'+m.error.message), { code: m.error.code, data: m.error.data })) : of(m.result as T))
    )
  }

  notification$(method: string) { return this.inbound$.pipe(filter((m): m is RpcNt => !!(m as any).method && !(m as any).id), filter(m => m.method === method), map(m => m.params)) }

  subscribeTopic$(topic: string, filterObj: any) {
    const doSub$ = defer(() => this.call$<{ token: string }>('subscribe', { topic, filter: filterObj }))
    const opened$ = this.online$.pipe(filter(Boolean))
    return merge(EMPTY, opened$).pipe(
      switchMap(() => doSub$),
      switchMap(({ token }) => this.inbound$.pipe(
        filter((m): m is RpcNt => !!(m as any).method && !(m as any).id),
        filter(m => m.method.startsWith(topic + '.')),
        map(m => ({ method: m.method, params: m.params })),
        finalize(() => { void firstValueFrom(this.call$('unsubscribe', { token })).catch(() => {}) })
      ))
    )
  }

  first<T>(obs$: Observable<T>) { return firstValueFrom(obs$) }
}
```

## 附：集成示例（节选）

```ts
// 查询文件分段
const q = useQuery({
  queryKey: ['file', path, startLine, maxLines],
  queryFn: () => ws.first(ws.call('file.getChunk', { path, startLine, maxLines }))
})

// 订阅批注并直改缓存（按主题订阅，区分子方法）
useEffect(()=> {
  const sub = ws.subscribeTopic$('annotations', {}).subscribe(({ method, params }) => {
    if (method === 'annotations.deleted' && params?.id) {
      qc.setQueryData<Annotation[]>(['annotations'], (prev=[]) => prev.filter(a => a.id !== params.id))
    } else if ((method === 'annotations.created' || method === 'annotations.updated') && params?.annotation) {
      const ann = params.annotation as Annotation
      qc.setQueryData<Annotation[]>(['annotations'], (prev=[]) => upsert(prev, ann))
    }
  })
  return () => sub.unsubscribe()
}, [])

// 文件变更精准失效
useEffect(()=> {
  const sub = ws.subscribeTopic$('file', { path }).subscribe(({ params }) => {
    const ev = params as { path: string; fromPath?: string }
    if (ev.path === path || ev.fromPath === path) qc.invalidateQueries({ queryKey: ['file', path] })
  })
  return () => sub.unsubscribe()
}, [path])
```

```ts
// tree.changed（impactedPaths）处理示意
useEffect(()=> {
  const sub = ws.subscribeTopic<any>('tree', { dir: currentDir || '.' }).subscribe(ev => {
    const truncated = !!ev?.summary?.truncated
    const paths: string[] = ev?.impactedPaths || []
    if (!truncated && paths.length) {
      const dirs = calcAffectedDirs(paths)
      const root = useAppStore.getState().currentRoot || ''
      dirs.forEach(d => qc.invalidateQueries({ queryKey: ['tree', root, d] }))
    } else {
      const dir = currentDir || '.'
      const root = useAppStore.getState().currentRoot || ''
      qc.invalidateQueries({ queryKey: ['tree', root, dir] })
    }
  })
  return () => sub.unsubscribe()
}, [currentDir])

function calcAffectedDirs(paths: string[]) {
  const dirs = new Set(paths.map(p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'))
  const sorted = Array.from(dirs).sort((a,b)=> a.length-b.length)
  const res: string[] = []
  for (const d of sorted) { if (!res.some(x => d === x || d.startsWith(x + '/'))) res.push(d) }
  return res
}
```

## 附注

为避免混淆，本文件仅保留一份 RxJS 客户端骨架与集成示例；如需更多变体，请参考项目代码或后续补充文档。
