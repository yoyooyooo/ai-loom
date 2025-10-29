import { WsRxClient } from './rx-client'
import type {
  FileChangedPayload,
  TreeChangedPayload,
  AnnotationsCreatedPayload,
  AnnotationsUpdatedPayload,
  AnnotationsDeletedPayload,
  AnnotationsVerifyDonePayload,
  SessionResyncPayload
} from '@/lib/ws/event-payloads'
import { isCodexEventMethod } from '@/lib/ws/types'
import { filter } from 'rxjs/operators'

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
  if (typeof location !== 'undefined') {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'
  }
  return 'ws://127.0.0.1/ws'
}

class WsSingleton {
  private client?: WsRxClient
  // 默认启用 WS；仅当 VITE_USE_WS 显式为 '0' 或 'false' 时禁用
  enabled = (() => {
    const v = (import.meta as any).env?.VITE_USE_WS
    if (v == null) return true
    const s = String(v).toLowerCase()
    return !(s === '0' || s === 'false')
  })()
  url = deriveWsUrl()
  private ensure() {
    if (!this.client) this.client = new WsRxClient(this.url)
    return this.client
  }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.ensure().call<T>(method, params, timeoutMs)
  }
  first<T>(obs$: import('rxjs').Observable<T>) {
    return this.ensure().first<T>(obs$)
  }
  subscribeTopic$(topic: 'file' | 'tree' | 'annotations' | 'chat', filter?: any) {
    return this.ensure().subscribeTopic$(topic, filter)
  }
  // Typed business notifications
  notification$(method: 'file.changed'): import('rxjs').Observable<FileChangedPayload>
  notification$(method: 'tree.changed'): import('rxjs').Observable<TreeChangedPayload>
  notification$(method: 'annotations.created'): import('rxjs').Observable<AnnotationsCreatedPayload>
  notification$(method: 'annotations.updated'): import('rxjs').Observable<AnnotationsUpdatedPayload>
  notification$(method: 'annotations.deleted'): import('rxjs').Observable<AnnotationsDeletedPayload>
  notification$(method: 'annotations.verify.done'): import('rxjs').Observable<AnnotationsVerifyDonePayload>
  notification$(method: 'session.resync'): import('rxjs').Observable<SessionResyncPayload>
  notification$(method: string): import('rxjs').Observable<any>
  notification$(method: string) {
    return (this.ensure() as any).notification$(method) as import('rxjs').Observable<any>
  }
  get online$() {
    return this.ensure().online$
  }
  get events$() {
    return (this.ensure() as any).events$ as import('rxjs').Observable<{
      method: string
      params: any
    }>
  }
  primeConversationCursor(conversationId: string, eventId: number) {
    this.ensure().primeConversationCursor(conversationId, eventId)
  }
  codex$() {
    return this.events$.pipe(
      filter((ev) => typeof ev?.method === 'string' && isCodexEventMethod(ev.method))
    )
  }
  chat$() {
    return this.events$.pipe(filter((ev) => typeof ev?.method === 'string' && ev.method.startsWith('chat.')))
  }
  get state() {
    return this.ensure().state
  }
  get subscriptions() {
    return (this.ensure() as any).subscriptionsSnapshot?.() as Array<{ topic: string; filter: any }>
  }
}

export const ws = new WsSingleton()

// Test helpers（在 Vitest 中通过 `vi.mock('@/lib/ws/singleton')` 覆盖）
export const __emit: (method: string, params?: any) => void = () => {
  throw new Error('__emit is only available in mocked ws singleton for tests')
}

export const __resetWsMock: () => void = () => {
  throw new Error('__resetWsMock is only available in mocked ws singleton for tests')
}
