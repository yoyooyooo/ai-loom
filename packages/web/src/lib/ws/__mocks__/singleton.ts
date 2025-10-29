import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { filter, map } from 'rxjs/operators'

type SubRecord = { topic: string; filter: Record<string, unknown> }

const eventsSubject = new Subject<{ method: string; params: any }>()
const online$ = new BehaviorSubject<boolean>(true)
let filters: SubRecord[] = []
let subs: Array<{ unsubscribe: () => void }> = []
let resumeQueue: Array<{ method: string; params?: any }> = []
let onlineState: 'up' | 'down' = 'up'

function reset() {
  filters = []
  subs = []
  resumeQueue = []
  // 清理 subject：不可 complete 全局 subject，以免影响后续用例；仅重置内部状态
  setOnline(true)
}

function setOnline(up: boolean) {
  onlineState = up ? 'up' : 'down'
  online$.next(up)
}

function matchTopic(topic: 'file'|'tree'|'annotations'|'chat', ev: { method: string }) {
  if (topic === 'file' && ev.method === 'file.changed') return true
  if (topic === 'tree' && ev.method === 'tree.changed') return true
  if (topic === 'annotations' && ev.method.startsWith('annotations.')) return true
  if (topic === 'chat' && (ev.method.startsWith('chat.') || ev.method.startsWith('codex/'))) return true
  return false
}

export const ws = {
  enabled: true,
  url: 'ws://mock',
  get state() { return onlineState },
  get online$() { return online$.asObservable() },
  get events$() { return eventsSubject.asObservable() },

  call<T = any>(method: string, params?: any, _timeoutMs?: number): Observable<T> {
    return new Observable<T>((subscriber) => {
      // 只处理我们用到的 RPC：subscribe / unsubscribe / events.resume
      if (method === 'subscribe') {
        filters.push({ topic: String(params?.topic || ''), filter: params?.filter || {} })
        subscriber.next({ ok: true } as any)
        subscriber.complete()
        return
      }
      if (method === 'unsubscribe') {
        // no-op；按 token 删除订阅（测试不强依赖）
        subscriber.next({ ok: true } as any)
        subscriber.complete()
        return
      }
      if (method === 'events.resume') {
        const payload = { events: resumeQueue }
        subscriber.next(payload as any)
        subscriber.complete()
        return
      }
      // 其它 RPC：直接返回 ok
      subscriber.next({ ok: true } as any)
      subscriber.complete()
    })
  },

  first<T>(obs$: Observable<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let sub: any
      sub = obs$.subscribe({
        next: (v) => { try { resolve(v) } finally { try { sub?.unsubscribe?.() } catch {} } },
        error: (e) => { try { reject(e) } finally { try { sub?.unsubscribe?.() } catch {} } }
      })
    })
  },

  subscribeTopic$(topic: 'file' | 'tree' | 'annotations' | 'chat', filterObj?: any) {
    filters.push({ topic, filter: filterObj || {} })
    return new Observable<{ method: string; params: any }>((subscriber) => {
      const sub = eventsSubject.subscribe((ev) => {
        if (matchTopic(topic, ev)) subscriber.next(ev)
      })
      subs.push({ unsubscribe: () => sub.unsubscribe() })
      return () => sub.unsubscribe()
    })
  },

  notification$(method: string) {
    return eventsSubject.asObservable().pipe(
      filter((ev) => ev.method === method),
      map((ev) => ev.params)
    )
  },

  codex$() {
    return eventsSubject.asObservable().pipe(filter((ev) => ev.method.startsWith('codex/')))
  },
  chat$() {
    return this.codex$()
  },

  // 测试辅助 API（仅在 vi.mock 环境下使用）
  __emit(method: string, params: any) {
    eventsSubject.next({ method, params })
  },
  __queueResume(events: Array<{ method: string; params?: any }>) {
    resumeQueue = Array.isArray(events) ? events.slice() : []
  },
  __getFilters() { return [...filters] },
  __getSubscriptions() { return [...subs] },
  __resetWsMock: reset,
  __setOnline: setOnline
}

// 便捷导出（测试直接 import 使用）
export const __emit = (method: string, params: any) => ws.__emit(method, params)
export const __queueResume = (events: Array<{ method: string; params?: any }>) => ws.__queueResume(events)
export const __resetWsMock = () => ws.__resetWsMock()
export const __getFilters = () => ws.__getFilters()
export const __getSubscriptions = () => ws.__getSubscriptions()
export const __setOnline = (up: boolean) => ws.__setOnline(up)

export default { ws }
