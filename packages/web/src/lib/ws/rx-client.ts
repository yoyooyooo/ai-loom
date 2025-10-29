import { BehaviorSubject, Observable, Subject } from 'rxjs'
import { filter, map } from 'rxjs/operators'
import { chatTrace } from '@/lib/logger'

type Json = any

const GLOBAL_CONV_LAST_KEY = 'ailoom.chat.convLast'
function makeConvLastKey(url: string): string {
  try {
    const u = new URL(url)
    const host = `${u.protocol}//${u.host}`
    return `${GLOBAL_CONV_LAST_KEY}@${host}`
  } catch {
    return GLOBAL_CONV_LAST_KEY
  }
}

type RpcResult = {
  jsonrpc: '2.0'
  id: string | number | null
  result?: any
  error?: { code: string; message: string; data?: any }
}

export class WsRxClient {
  private url: string
  private ws: WebSocket | null = null
  private idSeq = 1
  private pending = new Map<
    string | number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >()
  private reconnectTimer: any = null
  private backoffMs = 300
  private subsWanted = new Map<string, { topic: string; filter: any }>()
  private lastEventId = 0
  private codexEventLastId = 0
  private codexEventLastKey = ''
  private convLast: Record<string, number> = {}
  private convLastKey: string
  private convLastPersistTimer: any = null

  // events
  private eventsSubject = new Subject<{ method: string; params: any }>()
  public events$ = this.eventsSubject.asObservable()

  // connection state
  private onlineSubject = new BehaviorSubject<boolean>(false)
  public online$ = this.onlineSubject.asObservable()
  public state: 'down' | 'connecting' | 'up' = 'down'

  constructor(url: string) {
    this.url = url
    this.convLastKey = makeConvLastKey(url)
    this.convLast = this.loadConvLast()
    this.connect()
  }

  private connect() {
    if (this.ws || this.state === 'connecting') return
    this.state = 'connecting'
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.state = 'up'
        this.onlineSubject.next(true)
        this.backoffMs = 300
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[ws] open', this.url)
        }
        // 重放订阅
        for (const { topic, filter } of this.subsWanted.values()) {
          this.send({
            jsonrpc: '2.0',
            id: this.nextId(),
            method: 'subscribe',
            params: { topic, filter }
          })
          if (topic === 'chat') {
            const cid = typeof filter?.conversationId === 'string' ? filter.conversationId : undefined
            if (cid) {
              this.resumeChat(cid).catch(() => {})
            }
          }
        }
        // 默认不恢复 chat 历史；如需启用，可设置 VITE_WS_RESUME=1
        if ((import.meta as any).env?.VITE_WS_RESUME === '1') {
          this.tryResume()
        }
      }
      ws.onmessage = (ev) => {
        const data = String(ev.data || '')
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          try {
            const v = JSON.parse(data)
            if (v?.method && v?.jsonrpc === '2.0') {
              // eslint-disable-next-line no-console
              console.log('[ws] event', v.method)
            }
          } catch {}
        }
        chatTrace('ws.rxClient.onMessage', { size: data.length })
        this.onMessage(data)
      }
      ws.onerror = () => {
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[ws] error')
        }
        this.scheduleReconnect()
      }
      ws.onclose = () => {
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[ws] close')
        }
        this.scheduleReconnect()
      }
    } catch {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    this.state = 'down'
    this.onlineSubject.next(false)
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    if (this.reconnectTimer) return
    const wait = Math.min(this.backoffMs, 5000) + Math.floor(Math.random() * 200)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.backoffMs = Math.min(this.backoffMs * 2, 5000)
      this.connect()
    }, wait)
  }

  private loadConvLast(): Record<string, number> {
    if (typeof window === 'undefined') return {}
    try {
      const storage = (window as any).localStorage
      if (!storage || typeof storage.getItem !== 'function') return {}
      // 优先读取 namespaced key；兼容旧 key 作为后备
      const raw = storage.getItem(this.convLastKey) ?? storage.getItem(GLOBAL_CONV_LAST_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return {}
      const out: Record<string, number> = {}
      for (const [key, value] of Object.entries(parsed as Record<string, any>)) {
        const num = typeof value === 'number' ? value : parseInt(String(value), 10)
        if (Number.isFinite(num) && num > 0) out[key] = num
      }
      return out
    } catch {
      return {}
    }
  }

  private scheduleConvLastPersist() {
    if (typeof window === 'undefined') return
    const storage = (window as any).localStorage
    if (!storage || typeof storage.setItem !== 'function') return
    if (this.convLastPersistTimer) return
    this.convLastPersistTimer = setTimeout(() => {
      this.convLastPersistTimer = null
      try {
        storage.setItem(this.convLastKey, JSON.stringify(this.convLast))
      } catch {}
    }, 250)
  }

  private nextId(): number {
    return this.idSeq++
  }

  private send(obj: any) {
    const txt = JSON.stringify(obj)
    if (!this.ws || this.state !== 'up')
      throw Object.assign(new Error('WS_DOWN'), { code: 'WS_DOWN' })
    this.ws.send(txt)
  }

  private onMessage(txt: string) {
    try {
      const v: any = JSON.parse(txt)
      chatTrace('ws.rxClient.parsed', { method: v?.method, id: v?.id })
      // 响应
      if (v && v.jsonrpc === '2.0' && 'id' in v) {
        const pr = this.pending.get(v.id as any)
        if (pr) {
          this.pending.delete(v.id as any)
          if (v.error) {
            pr.reject(
              Object.assign(new Error(`${v.error.code}:${v.error.message || ''}`), {
                code: v.error.code
              })
            )
          } else {
            pr.resolve(v.result)
          }
        }
        return
      }
      // 通知
      if (v && v.jsonrpc === '2.0' && v.method) {
        const method = typeof v.method === 'string' ? v.method : ''
        const params = v.params ?? {}
        if (method === 'session.ping') {
          try {
            this.send({ jsonrpc: '2.0', method: 'session.pong', params: { ts: Date.now() } })
          } catch {}
        }
        // 仅对“可增量恢复的业务事件”更新 lastEventId，避免被 session.* 等观测事件推进游标导致 resume 丢失
        if (
          method === 'file.changed' ||
          method === 'tree.changed' ||
          method.startsWith('annotations.')
        ) {
          const eid = parseEventId(params)
          if (eid && eid > this.lastEventId) this.lastEventId = eid
        }
        let skip = false
        if (method.startsWith('chat.')) {
          const convId = typeof (params as any)?.conversationId === 'string' ? (params as any).conversationId : undefined
          const eid = parseEventId(params)
          if (convId && eid) {
            const prev = this.convLast[convId] || 0
            if (eid <= prev) {
              chatTrace('ws.rxClient.skipChatDup', {
                conversationId: convId,
                eventId: eid,
                last: prev,
                method
              })
              skip = true
            } else {
              this.convLast[convId] = eid
              this.scheduleConvLastPersist()
            }
          }
        }
        if (skip) return
        // 对 codex/event/* 做客户端去重（不推进全局 lastEventId，以免影响 resume）
        if (method.startsWith('codex/event')) {
          const eid = parseEventId(params)
          if (eid) {
            const key = `${method}#${eid}`
            chatTrace('ws.rxClient.codexEventId', {
              method,
              eventId: eid,
              lastEventId: this.codexEventLastId,
              lastKey: this.codexEventLastKey
            })
            if (eid < this.codexEventLastId) {
              chatTrace('ws.rxClient.codexEventId.skip_lt', { method, eventId: eid })
              return
            }
            if (key === this.codexEventLastKey) {
              chatTrace('ws.rxClient.codexEventId.skip_dupkey', { method, eventId: eid })
              return
            }
            if (eid > this.codexEventLastId) this.codexEventLastId = eid
            this.codexEventLastKey = key
          }
        }
        this.eventsSubject.next({ method, params })
        chatTrace('ws.rxClient.emitted', { method })
      }
    } catch (error) {
      chatTrace('ws.rxClient.parseError', {
        message: error instanceof Error ? error.message : String(error),
        snippet: txt.slice(0, 120)
      })
      // eslint-disable-next-line no-console
      console.error('[ws] parse error', error)
    }
  }

  private async tryResume() {
    const after = this.lastEventId || 0
    try {
      const args: any = after === 0 ? { after, tail: 128 } : { after }
      const res: any = await this.first(this.call('events.resume', args, 8000))
      const events: any[] = Array.isArray(res?.events) ? res.events : []
      if ((import.meta as any).env?.VITE_WS_DEBUG) {
        // eslint-disable-next-line no-console
        console.log('[ws] resume', { after, count: events.length, truncated: !!res?.truncated })
      }
      for (const ev of events) {
        // 仅对文件/树/批注做补发；跳过 chat.*，避免刷新后对话历史重播
        const m = ev?.method as string | undefined
        if (!m) continue
        if (m === 'file.changed' || m === 'tree.changed' || m.startsWith('annotations.')) {
          const eid = parseEventId(ev?.params)
          if (eid && eid > this.lastEventId) this.lastEventId = eid
          this.eventsSubject.next({ method: m, params: ev?.params })
        }
      }
      if (res?.truncated) {
        this.eventsSubject.next({ method: 'session.resync', params: { reason: 'truncated' } })
      }
    } catch {
      this.eventsSubject.next({ method: 'session.resync', params: { reason: 'resume_failed' } })
    }
  }

  async resumeChat(conversationId?: string, opts: { tail?: number } = {}) {
    const cid = typeof conversationId === 'string' && conversationId ? conversationId : undefined
    if (!cid) return
    const after = this.convLast[cid] || 0
    const tail = opts.tail ?? 128
    const params: any = {
      after,
      topic: 'chat',
      filter: { conversationId: cid }
    }
    if (after === 0 && tail > 0) params.tail = tail
    try {
      const res: any = await this.first(this.call('events.resume', params, 8000))
      const events: any[] = Array.isArray(res?.events) ? res.events : []
      let updated = false
      for (const ev of events) {
        const method = ev?.method
        if (typeof method !== 'string') continue
        const payload = ev?.params ?? {}
        const eid = parseEventId(payload)
        const eventCid = typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
        if (eventCid && eid) {
          const prev = this.convLast[eventCid] || 0
          if (eid <= prev) {
            continue
          }
          this.convLast[eventCid] = eid
          updated = true
        }
        this.eventsSubject.next({ method, params: payload })
      }
      if (updated) this.scheduleConvLastPersist()
      if (res?.truncated) {
        this.eventsSubject.next({ method: 'session.resync', params: { reason: 'truncated' } })
      }
    } catch (error) {
      this.eventsSubject.next({ method: 'session.resync', params: { reason: 'resume_failed' } })
      throw error
    }
  }

  call$<T = any>(method: string, params?: Json, timeoutMs = 15000): Observable<T> {
    return new Observable<T>((subscriber) => {
      const id = this.nextId()
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          subscriber.error(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' }))
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          subscriber.next(v)
          subscriber.complete()
        },
        reject: (e) => {
          clearTimeout(timer)
          subscriber.error(e)
        }
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        subscriber.error(e)
      }
      return () => {
        clearTimeout(timer)
        this.pending.delete(id)
      }
    })
  }

  // 主题订阅（自动重订阅）
  subscribeTopic$(
    topic: 'file' | 'tree' | 'annotations' | 'chat',
    filter?: any
  ): Observable<{ method: string; params: any }> {
    const key = `${topic}:${normalizeFilter(filter || {})}`
    return new Observable((subscriber) => {
      this.subsWanted.set(key, { topic, filter: filter || {} })
      const doSub = async () => {
        try {
          await this.first(this.call('subscribe', { topic, filter }))
          if (topic === 'chat') {
            const cid = typeof (filter as any)?.conversationId === 'string' ? (filter as any).conversationId : undefined
            if (cid) {
              this.resumeChat(cid).catch(() => {})
            }
          }
        } catch {}
      }
      if (this.state === 'up') doSub()
      const sub = this.events$.subscribe((ev) => {
        if (matchTopic(key, ev)) {
          chatTrace('ws.rxClient.matchTopic', { key, method: ev.method })
          subscriber.next(ev)
        }
      })
      return () => {
        this.subsWanted.delete(key)
        sub.unsubscribe()
        // 退订
        try {
          this.first(this.call('unsubscribe', { token: key })).catch(() => {})
        } catch {}
      }
    })
  }

  // 类型化通知：当传入方法名时返回对应 payload
  notification$(method: string): Observable<any> {
    // 直接基于共享的 events$ 过滤并映射，避免重复包装 Observable
    return this.events$.pipe(
      filter((ev: any) => ev.method === method),
      map((ev: any) => ev.params)
    ) as unknown as Observable<any>
  }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.call$<T>(method, params, timeoutMs)
  }
  first<T>(obs$: Observable<T>) {
    return new Promise<T>((resolve, reject) => {
      let sub: any = null
      sub = obs$.subscribe({
        next: (v) => {
          resolve(v)
          sub?.unsubscribe()
        },
        error: reject
      })
    })
  }

  primeConversationCursor(conversationId: string, eventId: number) {
    if (!conversationId) return
    const eid = Number.isFinite(eventId) ? Math.floor(eventId) : NaN
    if (!Number.isFinite(eid) || eid <= 0) return
    const prev = this.convLast[conversationId] || 0
    if (eid > prev) {
      this.convLast[conversationId] = eid
      this.scheduleConvLastPersist()
    }
  }

  // 调试用：返回订阅快照
  subscriptionsSnapshot() {
    return Array.from(this.subsWanted.values()).map((s) => ({ topic: s.topic, filter: s.filter }))
  }
}

function normalizeFilter(filter: any) {
  try {
    const ks = Object.keys(filter).sort()
    const obj: any = {}
    for (const k of ks) {
      const v = (filter as any)[k]
      if (v != null) obj[k] = v
    }
    return JSON.stringify(obj)
  } catch {
    return JSON.stringify(filter || {})
  }
}

function matchTopic(key: string, ev: { method: string; params: any }) {
  // key 形如 "<topic>:<json-filter>"，需要取冒号前缀
  const idx = key.indexOf(':')
  const topic = idx >= 0 ? key.slice(0, idx) : key
  if (topic === 'file' && ev.method === 'file.changed') return true
  if (topic === 'tree' && ev.method === 'tree.changed') return true
  if (topic === 'annotations' && ev.method.startsWith('annotations.')) return true
  if (topic === 'chat' && (ev.method.startsWith('chat.') || ev.method.startsWith('codex/'))) return true
  return false
}

function parseEventId(params: any): number | 0 {
  try {
    const raw = params?.eventId
    if (raw == null) return 0
    if (typeof raw === 'number') return raw
    const n = parseInt(String(raw), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}
