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
import { filter, share } from 'rxjs/operators'

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
  private _codex$?: import('rxjs').Observable<{ method: string; params: any }>
  private _chat$?: import('rxjs').Observable<{ method: string; params: any }>
  // 默认启用 WS；仅当 VITE_USE_WS 显式为 '0' 或 'false' 时禁用
  enabled = (() => {
    const v = (import.meta as any).env?.VITE_USE_WS
    if (v == null) return true
    const s = String(v).toLowerCase()
    return !(s === '0' || s === 'false')
  })()
  url = deriveWsUrl()
  private ensure() {
    if (!this.client) {
      this.client = new WsRxClient(this.url)
      this.client.start()
    }
    return this.client
  }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.ensure().call<T>(method, params, timeoutMs)
  }
  // 便捷：一次性调用，直接返回首个响应值
  async callOnce<T>(method: string, params?: any, timeoutMs?: number) {
    return await this.ensure().first<T>(this.call<T>(method, params, timeoutMs))
  }
  first<T>(obs$: import('rxjs').Observable<T>) {
    return this.ensure().first<T>(obs$)
  }
  subscribeTopic$(topic: 'file' | 'tree' | 'annotations' | 'chat', filter?: any) {
    return this.ensure().subscribeTopic$(topic, filter)
  }
  // 主动按会话 resume（用于自愈/补偿）
  resumeChat(conversationId: string, opts: { tail?: number } = {}) {
    return (this.ensure() as any).resumeChat(conversationId, opts)
  }
  // Typed business notifications
  notification$(method: 'file.changed'): import('rxjs').Observable<FileChangedPayload>
  notification$(method: 'tree.changed'): import('rxjs').Observable<TreeChangedPayload>
  notification$(method: 'annotations.created'): import('rxjs').Observable<AnnotationsCreatedPayload>
  notification$(method: 'annotations.updated'): import('rxjs').Observable<AnnotationsUpdatedPayload>
  notification$(method: 'annotations.deleted'): import('rxjs').Observable<AnnotationsDeletedPayload>
  notification$(
    method: 'annotations.verify.done'
  ): import('rxjs').Observable<AnnotationsVerifyDonePayload>
  notification$(method: 'session.resync'): import('rxjs').Observable<SessionResyncPayload>
  notification$(method: string): import('rxjs').Observable<any>
  notification$(method: string) {
    // 直接委托给底层客户端；依赖本方法的重载在调用处保留精确类型
    return this.ensure().notification$(method)
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
  get errors$() {
    return (this.ensure() as any).errors$ as import('rxjs').Observable<import('./rx-client').WsClientError>
  }
  primeConversationCursor(conversationId: string, eventId: number) {
    this.ensure().primeConversationCursor(conversationId, eventId)
  }
  codex$() {
    if (!this._codex$) {
      this._codex$ = this.events$.pipe(
        filter((ev) => typeof ev?.method === 'string' && isCodexEventMethod(ev.method)),
        share()
      )
    }
    return this._codex$
  }
  chat$() {
    if (!this._chat$) {
      this._chat$ = this.events$.pipe(
        filter((ev) => typeof ev?.method === 'string' && ev.method.startsWith('chat.')),
        share()
      )
    }
    return this._chat$
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

export const __getFilters: () => Array<{ topic: string; filter: any }> = () => {
  throw new Error('__getFilters is only available in mocked ws singleton for tests')
}

export const __setOnline: (up: boolean) => void = () => {
  throw new Error('__setOnline is only available in mocked ws singleton for tests')
}
