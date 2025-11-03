import { BehaviorSubject, Observable, Subject, firstValueFrom, using, of, timer, race, Subscription } from 'rxjs'
import {
  filter,
  map,
  share,
  shareReplay,
  switchMap,
  take,
  timeout as opTimeout,
  mapTo,
  scan,
  pairwise,
  startWith,
  withLatestFrom,
  distinctUntilChanged
} from 'rxjs/operators'
import { chatTrace } from '@/lib/logger'

type Json = any

export type WsClientError = {
  source:
    | 'ws' // WebSocket 层（onerror/onclose/解析失败）
    | 'rpc' // 通用 RPC 调用
    | 'subscribe' // 单条 subscribe 失败
    | 'unsubscribe' // 单条 unsubscribe 失败
    | 'subscribeMany' // 批量订阅失败
    | 'resume' // resume/按会话 resume 失败
  code?: string
  message?: string
  method?: string
  token?: string
  details?: any
  ts: number
}

const GLOBAL_CONV_LAST_KEY = 'ailoom.chat.convLast'
const GLOBAL_CONV_APPLIED_LAST_KEY = 'ailoom.chat.convAppliedLast'
function makeConvLastKey(url: string): string {
  try {
    const u = new URL(url)
    const host = `${u.protocol}//${u.host}`
    return `${GLOBAL_CONV_LAST_KEY}@${host}`
  } catch {
    return GLOBAL_CONV_LAST_KEY
  }
}

function makeConvAppliedLastKey(url: string): string {
  try {
    const u = new URL(url)
    const host = `${u.protocol}//${u.host}`
    return `${GLOBAL_CONV_APPLIED_LAST_KEY}@${host}`
  } catch {
    return GLOBAL_CONV_APPLIED_LAST_KEY
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
  private tokenObservables = new Map<string, Observable<{ method: string; params: any }>>()
  // 订阅管理（意图流 × 状态流）
  private intent$$ = new Subject<{ token: string; op: 'retain' | 'release' }>()
  private subscribedTokens = new Set<string>()
  private unsubscribeTimers = new Map<string, any>()
  private unsubDebounceMs: number = Number(
    (import.meta as any).env?.VITE_WS_UNSUB_DEBOUNCE_MS ?? 250
  )
  private batchEnabled: boolean = ((import.meta as any).env?.VITE_WS_SUBSCRIBE_BATCH ?? '0') === '1'
  private serverSupportsBatch: boolean | null = null
  // 旧本地计数实现遗留，已改为基于 share 的流管理
  private lastEventId = 0
  private codexEventLastId = 0
  private codexEventLastKey = ''
  private convLast: Record<string, number> = {}
  // 已“应用到 UI”的每会话游标（与 convLast 区分：convLast 表示“已看到”，convAppliedLast 表示“已落地”）
  private convAppliedLast: Record<string, number> = {}
  private convLastKey: string
  private convAppliedLastKey: string
  private convLastPersistTimer: any = null
  private convAppliedPersistTimer: any = null
  private serverLastEventId: number = 0

  // events
  private events$$ = new Subject<{ method: string; params: any }>()
  public events$ = this.events$$.asObservable()
  // errors
  private errors$$ = new Subject<WsClientError>()
  public errors$ = this.errors$$.asObservable()

  // connection state
  private online$$ = new BehaviorSubject<boolean>(false)
  public online$ = this.online$$.asObservable()
  public state: 'down' | 'connecting' | 'up' = 'down'

  private started = false
  private desiredSub?: Subscription
  private onlineSub?: Subscription
  private onlineUpSub?: Subscription

  constructor(url: string) {
    this.url = url
    this.convLastKey = makeConvLastKey(url)
    this.convAppliedLastKey = makeConvAppliedLastKey(url)
    this.convLast = this.loadConvLast()
    this.convAppliedLast = this.loadConvAppliedLast()
    // 测试兼容：暴露 onlineSubject（旧名）
    ;(this as any).onlineSubject = this.online$$
  }

  start() {
    if (this.started) return
    this.started = true
    this.connect()

    // 订阅意图聚合（scan）：token -> count
    const counts$ = this.intent$$.pipe(
      scan((acc, { token, op }) => {
        const next = new Map(acc)
        const c = next.get(token) || 0
        const v = op === 'retain' ? c + 1 : Math.max(0, c - 1)
        if (v === 0) next.delete(token)
        else next.set(token, v)
        return next
      }, new Map<string, number>()),
      shareReplay({ bufferSize: 1, refCount: true })
    )
    const desiredTokens$ = counts$.pipe(
      map((m) => new Set<string>(Array.from(m.keys()))),
      shareReplay({ bufferSize: 1, refCount: true })
    )
    const diff$ = desiredTokens$.pipe(
      startWith(new Set<string>()),
      pairwise(),
      map(([prev, curr]) => {
        const toAdd: string[] = []
        const toDel: string[] = []
        for (const t of curr) if (!prev.has(t)) toAdd.push(t)
        for (const t of prev) if (!curr.has(t)) toDel.push(t)
        return { toAdd, toDel }
      })
    )
    this.desiredSub = diff$.subscribe(({ toAdd, toDel }) => {
      chatTrace('ws.rxClient.desired.diff', { add: toAdd, del: toDel })
      const online = this.state === 'up'
      if (!online) return
      // 新增：取消待退订定时器
      toAdd.forEach((t) => {
        const timer = this.unsubscribeTimers.get(t)
        if (timer) {
          try {
            clearTimeout(timer)
          } catch {}
          this.unsubscribeTimers.delete(t)
        }
      })
      if (this.batchEnabled && toAdd.length > 1) {
        this.doSubscribeMany(toAdd).catch(() => {
          toAdd.forEach((t) => this.doSubscribeToken(t).catch(() => {}))
        })
      } else {
        toAdd.forEach((t) => this.doSubscribeToken(t).catch(() => {}))
      }
      toDel.forEach((t) => this.scheduleUnsubscribe(t))
    })

    // 连接状态变化：
    // - 上线：为 desired 集合同步订阅缺失项
    // - 下线：清空本地 subscribed 快照与去抖定时器
    this.onlineSub = this.online$.subscribe((online) => {
      chatTrace('ws.rxClient.online', { online })
      if (!online) {
        this.subscribedTokens.clear()
        try {
          this.unsubscribeTimers.forEach((h) => clearTimeout(h))
        } catch {}
        this.unsubscribeTimers.clear()
      }
    })
    const onlineUp$ = this.online$.pipe(distinctUntilChanged(), pairwise(), filter(([p, c]) => !p && !!c), mapTo(true))
    this.onlineUpSub = onlineUp$.pipe(withLatestFrom(desiredTokens$)).subscribe(([_, desired]) => {
      const missing = Array.from(desired).filter((t) => !this.subscribedTokens.has(t))
      if (missing.length === 0) return
      if (this.batchEnabled && missing.length > 1) {
        this.doSubscribeMany(missing).catch(() => {
          missing.forEach((t) => this.doSubscribeToken(t).catch(() => {}))
        })
      } else {
        missing.forEach((t) => this.doSubscribeToken(t).catch(() => {}))
      }
    })
  }

  private ensureStarted() {
    if (!this.started) this.start()
  }

  private reportError(partial: Omit<WsClientError, 'ts'>) {
    try {
      const payload: WsClientError = { ...partial, ts: Date.now() }
      this.errors$$.next(payload)
      chatTrace('ws.rxClient.error', payload)
      if ((import.meta as any).env?.VITE_WS_DEBUG) {
        // eslint-disable-next-line no-console
        console.warn('[ws] error', payload)
      }
    } catch {}
  }

  private connect() {
    if (this.ws || this.state === 'connecting') return
    this.state = 'connecting'
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = async () => {
        this.state = 'up'
        this.online$$.next(true)
        this.backoffMs = 300
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[ws] open', this.url)
        }
        // 获取一次服务器 last_event_id，用于 after 夹取（服务器重启时有效）
        try {
          const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
          if (!isVitest) {
            const info: any = await this.first(this.call('session.info', {}, 5000))
            const last = Number(info?.stats?.last_event_id ?? 0) || 0
            if (last > 0) this.serverLastEventId = last
          }
        } catch {
          this.serverLastEventId = 0
        }
        // 订阅重放交由 online$ 监听与 desired 集合同步完成
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
              v.method !== 'session.info' && console.log('[ws] event', v.method)
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
        this.reportError({ source: 'ws', code: 'ONERROR' })
        this.scheduleReconnect()
      }
      ws.onclose = () => {
        if ((import.meta as any).env?.VITE_WS_DEBUG) {
          // eslint-disable-next-line no-console
          console.log('[ws] close')
        }
        this.reportError({ source: 'ws', code: 'ONCLOSE' })
        this.scheduleReconnect()
      }
    } catch {
      this.reportError({ source: 'ws', code: 'CONNECT_THROW' })
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    this.state = 'down'
    this.online$$.next(false)
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

  private loadConvAppliedLast(): Record<string, number> {
    if (typeof window === 'undefined') return {}
    try {
      const storage = (window as any).localStorage
      if (!storage || typeof storage.getItem !== 'function') return {}
      const raw = storage.getItem(this.convAppliedLastKey)
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

  private scheduleConvAppliedLastPersist() {
    if (typeof window === 'undefined') return
    const storage = (window as any).localStorage
    if (!storage || typeof storage.setItem !== 'function') return
    if (this.convAppliedPersistTimer) return
    this.convAppliedPersistTimer = setTimeout(() => {
      this.convAppliedPersistTimer = null
      try {
        storage.setItem(this.convAppliedLastKey, JSON.stringify(this.convAppliedLast))
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
          const convId =
            typeof (params as any)?.conversationId === 'string'
              ? (params as any).conversationId
              : undefined
          const providerId =
            typeof (params as any)?.provider === 'string' ? (params as any).provider : undefined
          const eid = parseEventId(params)
          if (convId && eid) {
            const key = providerId ? `${providerId}|${convId}` : convId
            const prev = this.convLast[key] || 0
            if (eid <= prev) {
              chatTrace('ws.rxClient.skipChatDup', {
                conversationId: convId,
                eventId: eid,
                last: prev,
                method
              })
              skip = true
            } else {
              this.convLast[key] = eid
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
        this.events$$.next({ method, params })
        chatTrace('ws.rxClient.emitted', { method })
      }
    } catch (error) {
      chatTrace('ws.rxClient.parseError', {
        message: error instanceof Error ? error.message : String(error),
        snippet: txt.slice(0, 120)
      })
      this.reportError({
        source: 'ws',
        code: 'PARSE_ERROR',
        message: error instanceof Error ? error.message : String(error),
        details: { snippet: txt.slice(0, 120) }
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
          this.events$$.next({ method: m, params: ev?.params })
        }
      }
      if (res?.truncated) {
        this.events$$.next({ method: 'session.resync', params: { reason: 'truncated' } })
      }
    } catch {
      this.events$$.next({ method: 'session.resync', params: { reason: 'resume_failed' } })
      this.reportError({ source: 'resume', code: 'RESUME_FAILED', method: 'events.resume' })
    }
  }

  private async resumeChatWithFilter(
    conversationId?: string,
    providerId?: string,
    opts: { tail?: number } = {}
  ) {
    const cid = typeof conversationId === 'string' && conversationId ? conversationId : undefined
    if (!cid) return
    const key = providerId ? `${providerId}|${cid}` : cid
    // 优先使用“已应用游标”；回退到“已看到游标”
    const appliedAfter = this.convAppliedLast[key] || this.convAppliedLast[cid] || 0
    let after = appliedAfter || this.convLast[key] || 0
    try {
      const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
      if (!isVitest) {
        if (this.serverLastEventId === 0) {
          const info: any = await this.first(this.call('session.info', {}, 5000))
          const last = Number(info?.stats?.last_event_id ?? 0) || 0
          if (last > 0) this.serverLastEventId = last
        }
        const serverCap = Number(this.serverLastEventId || 0) || 0
        if (serverCap > 0 && after > serverCap) after = serverCap
      }
    } catch {}
    const tail = opts.tail ?? 128
    const params: any = {
      after,
      topic: 'chat',
      filter: { conversationId: cid, ...(providerId ? { providerId } : {}) }
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
        const eventCid =
          typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
        const eventPid =
          typeof (payload as any)?.provider === 'string' ? (payload as any).provider : undefined
        if (eventCid && eid) {
          const k = eventPid ? `${eventPid}|${eventCid}` : eventCid
          const prev = this.convLast[k] || 0
          if (eid <= prev) {
            continue
          }
          this.convLast[k] = eid
          // 同步更新“已应用”游标（快照重放视为已落地）
          const appliedPrevK = this.convAppliedLast[k] || 0
          if (eid > appliedPrevK) this.convAppliedLast[k] = eid
          const appliedPrevCid = this.convAppliedLast[eventCid] || 0
          if (eid > appliedPrevCid) this.convAppliedLast[eventCid] = eid
          updated = true
        }
        this.events$$.next({ method, params: payload })
      }
      if (updated) this.scheduleConvLastPersist()
      if (updated) this.scheduleConvAppliedLastPersist()
      if (res?.truncated) {
        this.events$$.next({ method: 'session.resync', params: { reason: 'truncated' } })
      }
    } catch (error) {
      this.events$$.next({ method: 'session.resync', params: { reason: 'resume_failed' } })
      this.reportError({
        source: 'resume',
        code: 'CHAT_RESUME_FAILED',
        method: 'events.resume',
        details: { conversationId: cid, providerId }
      })
      throw error
    }
  }

  async resumeChat(conversationId?: string, opts: { tail?: number } = {}) {
    return this.resumeChatWithFilter(conversationId, undefined, opts)
  }

  call$<T = any>(method: string, params?: Json, timeoutMs = 15000): Observable<T> {
    this.ensureStarted()
    const src$ = new Observable<T>((subscriber) => {
      const id = this.nextId()
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          const err = Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })
          this.reportError({ source: 'rpc', code: 'TIMEOUT', method, details: { id } })
          subscriber.error(err)
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
          try {
            const code = typeof (e as any)?.code === 'string' ? (e as any).code : undefined
            this.reportError({ source: 'rpc', code, method, details: { id } })
          } catch {}
          subscriber.error(e)
        }
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        try {
          const code = typeof (e as any)?.code === 'string' ? (e as any).code : 'SEND_FAILED'
          this.reportError({ source: 'rpc', code, method })
        } catch {}
        subscriber.error(e)
      }
      return () => {
        clearTimeout(timer)
        this.pending.delete(id)
      }
    })
    // 单次 RPC 在同一返回 Observable 上多次订阅时仅触发一次发送，复用结果
    return src$.pipe(shareReplay({ bufferSize: 1, refCount: true }))
  }

  // 主题订阅（自动重订阅）
  subscribeTopic$(
    topic: 'file' | 'tree' | 'annotations' | 'chat',
    subFilter?: any
  ): Observable<{ method: string; params: any }> {
    this.ensureStarted()
    const key = `${topic}:${normalizeFilter(subFilter || {})}`
    const existed = this.tokenObservables.get(key)
    if (existed) return existed
    const self = this
    const source$ = (
      using(
        () => {
          // 仅声明意图，不直接 RPC；RPC 由 desired 集合与 online 状态驱动
          self.subsWanted.set(key, { topic, filter: subFilter || {} })
          try {
            self.intent$$.next({ token: key, op: 'retain' })
          } catch {}
          return {
            unsubscribe: () => {
              try {
                self.intent$$.next({ token: key, op: 'release' })
              } catch {}
            }
          }
        },
        () =>
          (self.events$ as Observable<{ method: string; params: any }>).pipe(
            filter((ev: { method: string; params: any }) => matchTopic(key, ev))
          )
      ) as Observable<{ method: string; params: any }>
    ).pipe(
      share({
        connector: () => new Subject<{ method: string; params: any }>(),
        // 延迟重置在某些构建器上会触发类型与运行时差异，这里采用立即重置规避闪退
        resetOnRefCountZero: true,
        resetOnError: true,
        resetOnComplete: true
      })
    )
    this.tokenObservables.set(key, source$)
    return source$
  }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.call$<T>(method, params, timeoutMs)
  }
  first<T>(obs$: Observable<T>) {
    return firstValueFrom(obs$)
  }

  // 便捷：按 method 分流的通知流
  notification$<T = any>(method: string): Observable<T> {
    return this.events$.pipe(
      filter((ev) => typeof ev?.method === 'string' && ev.method === method),
      map((ev) => ev.params as T),
      share()
    ) as unknown as Observable<T>
  }

  primeConversationCursor(conversationId: string, eventId: number) {
    if (!conversationId) return
    const eid = Number.isFinite(eventId) ? Math.floor(eventId) : NaN
    if (!Number.isFinite(eid) || eid <= 0) return
    const prevApplied = this.convAppliedLast[conversationId] || 0
    if (eid > prevApplied) {
      this.convAppliedLast[conversationId] = eid
      this.scheduleConvAppliedLastPersist()
    }
  }

  // 基于 token 的订阅/退订副作用（由 desired 集合与 online 状态驱动）
  private async doSubscribeToken(token: string) {
    try {
      const params = await this.getSubscribeParamsForToken(token)
      await this.first(this.call('subscribe', params))
      chatTrace('ws.rxClient.subscribe', { token, params })
      this.subscribedTokens.add(token)
    } catch (e) {
      try {
        this.reportError({ source: 'subscribe', code: (e as any)?.code, token })
      } catch {}
    }
  }

  private async doUnsubscribeToken(token: string) {
    try {
      if (!this.subscribedTokens.has(token)) return
      await this.first(this.call('unsubscribe', { token }))
    } catch (e) {
      try {
        this.reportError({ source: 'unsubscribe', code: (e as any)?.code, token })
      } catch {}
    } finally {
      chatTrace('ws.rxClient.unsubscribe', { token })
      this.subscribedTokens.delete(token)
      try {
        this.subsWanted.delete(token)
      } catch {}
    }
  }

  private scheduleUnsubscribe(token: string) {
    try {
      const prev = this.unsubscribeTimers.get(token)
      if (prev) clearTimeout(prev)
    } catch {}
    const h = setTimeout(
      () => {
        this.doUnsubscribeToken(token).catch(() => {})
        this.unsubscribeTimers.delete(token)
      },
      Math.max(0, this.unsubDebounceMs)
    )
    this.unsubscribeTimers.set(token, h)
  }

  // 批量订阅（可选，失败回退逐条）
  private async doSubscribeMany(tokens: string[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return
    try {
      // 单个直接走单条路径
      if (tokens.length === 1) return this.doSubscribeToken(tokens[0])
      // 预构建 items，并在失败时用于回退
      const items: any[] = []
      for (const t of tokens) {
        const p = await this.getSubscribeParamsForToken(t)
        items.push({ token: t, ...p })
      }
      // 若此前检测到不支持批量，则直接回退
      if (this.serverSupportsBatch === false) throw new Error('BATCH_UNSUPPORTED')
      // 尝试批量 RPC：subscribeMany({ items })
      await this.first(this.call('subscribeMany', { items }))
      items.forEach((it) => this.subscribedTokens.add(it.token))
      this.serverSupportsBatch = true
    } catch (e) {
      this.serverSupportsBatch = false
      try {
        this.reportError({ source: 'subscribeMany', code: (e as any)?.code, details: { count: tokens.length } })
      } catch {}
      await Promise.allSettled(tokens.map((t) => this.doSubscribeToken(t)))
    }
  }

  // 构建订阅参数（含 after/tail 计算）
  private async getSubscribeParamsForToken(token: string): Promise<any> {
    const rec = this.subsWanted.get(token)
    if (!rec) return { topic: 'chat', filter: {} }
    const { topic, filter } = rec
    const params: any = { topic, filter }
    if (topic === 'chat') {
      const cid = typeof filter?.conversationId === 'string' ? filter.conversationId : undefined
      const providerId =
        typeof filter?.providerId === 'string'
          ? filter.providerId
          : typeof filter?.provider === 'string'
            ? filter.provider
            : undefined
      if (cid) {
        const keyK = providerId ? `${providerId}|${cid}` : cid
        const afterApplied = this.convAppliedLast[keyK] || this.convAppliedLast[cid] || 0
        const afterSeen = this.convLast[keyK] || this.convLast[cid] || 0
        let after = afterApplied || afterSeen || 0
        try {
          const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
          if (!isVitest) {
            if (this.serverLastEventId === 0) {
              const info: any = await this.first(this.call('session.info', {}, 5000))
              const last = Number(info?.stats?.last_event_id ?? 0) || 0
              if (last > 0) this.serverLastEventId = last
            }
            const serverCap = Number(this.serverLastEventId || 0) || 0
            if (serverCap > 0 && after > serverCap) after = serverCap
          }
        } catch {}
        params.after = after
        if (!after) params.tail = 128
      }
    }
    return params
  }

  // 调试用：返回订阅快照
  subscriptionsSnapshot() {
    return Array.from(this.subsWanted.values()).map((s) => ({ topic: s.topic, filter: s.filter }))
  }

  // 等待指定会话的订阅“就绪”（订阅已建立且握手开始/结束可感知），用于在发送首条消息前消除空窗
  ensureChatReady$(conversationId: string, opts: { tail?: number; timeoutMs?: number } = {}) {
    const cid = conversationId
    const token = `chat:${normalizeFilter({ conversationId: cid })}`
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs ?? 5000))
    // 使用 using：在该流激活期间保持 chat 订阅引用，释放时自动退订一次（由底层意图流去抖）
    const ready$Factory = () => {
      // 触发一次订阅构建与 subscribe 调用，确保 0→1 场景立即建立订阅
      const trigger$ = of(null).pipe(
        switchMap(async () => {
          if (!this.subscribedTokens.has(token)) {
            const params = await this.getSubscribeParamsForToken(token)
            await this.first(this.call('subscribe', params))
          }
        })
      )
      const begin$ = (this.notification$('chat.session.sync_begin') as Observable<any>).pipe(
        filter((p: any) => (p?.conversationId || p?.conversationID) === cid),
        take(1)
      )
      // 去除“仅凭本地 subscribedTokens 判断就绪”的快速路径；
      // 以收到握手 begin 作为唯一就绪信号，确保服务端已建立订阅并开始窗口，避免订阅与发送之间的竞态导致空窗。
      return trigger$.pipe(
        switchMap(() => begin$.pipe(map(() => null))),
        opTimeout({ each: timeoutMs })
      )
    }
    return using(
      () => {
        const sub = this.subscribeTopic$('chat', { conversationId: cid }).subscribe(() => {})
        return { unsubscribe: () => sub.unsubscribe() }
      },
      () => ready$Factory()
    )
  }

  async ensureChatReady(conversationId: string, opts: { tail?: number; timeoutMs?: number } = {}) {
    await firstValueFrom(this.ensureChatReady$(conversationId, opts))
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
  if (topic === 'chat' && (ev.method.startsWith('chat.') || ev.method.startsWith('codex/')))
    return true
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
