import { BehaviorSubject, Observable, Subject } from 'rxjs'

type Json = any

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
  private pending = new Map<string | number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private reconnectTimer: any = null
  private backoffMs = 300
  private subsWanted = new Map<string, { topic: string; filter: any }>()
  private lastEventId = 0

  // events
  private eventsSubject = new Subject<{ method: string; params: any }>()
  public events$ = this.eventsSubject.asObservable()

  // connection state
  private onlineSubject = new BehaviorSubject<boolean>(false)
  public online$ = this.onlineSubject.asObservable()
  public state: 'down' | 'connecting' | 'up' = 'down'

  constructor(url: string) {
    this.url = url
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
          this.send({ jsonrpc: '2.0', id: this.nextId(), method: 'subscribe', params: { topic, filter } })
        }
        // 尝试事件增量恢复
        this.tryResume()
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
      try { this.ws.close() } catch {}
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

  private nextId(): number { return this.idSeq++ }

  private send(obj: any) {
    const txt = JSON.stringify(obj)
    if (!this.ws || this.state !== 'up') throw Object.assign(new Error('WS_DOWN'), { code: 'WS_DOWN' })
    this.ws.send(txt)
  }

  private onMessage(txt: string) {
    try {
      const v: any = JSON.parse(txt)
      // 响应
      if (v && v.jsonrpc === '2.0' && 'id' in v) {
        const pr = this.pending.get(v.id as any)
        if (pr) {
          this.pending.delete(v.id as any)
          if (v.error) {
            pr.reject(Object.assign(new Error(`${v.error.code}:${v.error.message || ''}`), { code: v.error.code }))
          } else {
            pr.resolve(v.result)
          }
        }
        return
      }
      // 通知
        if (v && v.jsonrpc === '2.0' && v.method) {
          if (v.method === 'session.ping') {
            try {
              this.send({ jsonrpc: '2.0', method: 'session.pong', params: { ts: Date.now() } })
            } catch {}
          }
          // 仅对“可增量恢复的业务事件”更新 lastEventId，避免被 session.* 等观测事件推进游标导致 resume 丢失
          if (v.method === 'file.changed' || v.method === 'tree.changed' || (typeof v.method === 'string' && v.method.startsWith('annotations.'))) {
            const eid = parseEventId(v?.params)
            if (eid && eid > this.lastEventId) this.lastEventId = eid
          }
          this.eventsSubject.next({ method: v.method, params: v.params })
        }
    } catch {}
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
        const eid = parseEventId(ev?.params)
        if (eid && eid > this.lastEventId) this.lastEventId = eid
        this.eventsSubject.next({ method: ev?.method, params: ev?.params })
      }
      if (res?.truncated) {
        this.eventsSubject.next({ method: 'session.resync', params: { reason: 'truncated' } })
      }
    } catch {
      this.eventsSubject.next({ method: 'session.resync', params: { reason: 'resume_failed' } })
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
        resolve: (v) => { clearTimeout(timer); subscriber.next(v); subscriber.complete() },
        reject: (e) => { clearTimeout(timer); subscriber.error(e) }
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        subscriber.error(e)
      }
      return () => { clearTimeout(timer); this.pending.delete(id) }
    })
  }

  // 主题订阅（自动重订阅）
  subscribeTopic$(topic: 'file' | 'tree' | 'annotations', filter?: any): Observable<{ method: string; params: any }> {
    const key = `${topic}:${normalizeFilter(filter || {})}`
    return new Observable((subscriber) => {
      this.subsWanted.set(key, { topic, filter: filter || {} })
      const doSub = async () => {
        try { await this.first(this.call('subscribe', { topic, filter })) } catch {}
      }
      if (this.state === 'up') doSub()
      const sub = this.events$.subscribe((ev) => {
        if (matchTopic(key, ev)) subscriber.next(ev)
      })
      return () => {
        this.subsWanted.delete(key)
        sub.unsubscribe()
        // 退订
        try { this.first(this.call('unsubscribe', { token: key })).catch(() => {}) } catch {}
      }
    })
  }

  notification$(method: string): Observable<any> {
    return new Observable((subscriber) => {
      const sub = this.events$.subscribe((ev) => { if (ev.method === method) subscriber.next(ev.params) })
      return () => sub.unsubscribe()
    })
  }

  call<T>(method: string, params?: any, timeoutMs?: number) {
    return this.call$<T>(method, params, timeoutMs)
  }
  first<T>(obs$: Observable<T>) { return new Promise<T>((resolve, reject) => {
    const sub = obs$.subscribe({ next: (v) => { resolve(v); sub.unsubscribe() }, error: reject })
  }) }

  // 调试用：返回订阅快照
  subscriptionsSnapshot() {
    return Array.from(this.subsWanted.values()).map((s) => ({ topic: s.topic, filter: s.filter }))
  }
}

function normalizeFilter(filter: any) {
  try {
    const ks = Object.keys(filter).sort()
    const obj: any = {}
    for (const k of ks) { const v = (filter as any)[k]; if (v != null) obj[k] = v }
    return JSON.stringify(obj)
  } catch { return JSON.stringify(filter || {}) }
}

function matchTopic(key: string, ev: { method: string; params: any }) {
  const [topic] = key.split(':', 1) as any
  if (topic === 'file' && ev.method === 'file.changed') return true
  if (topic === 'tree' && ev.method === 'tree.changed') return true
  if (topic === 'annotations' && ev.method.startsWith('annotations.')) return true
  return false
}

function parseEventId(params: any): number | 0 {
  try {
    const raw = params?.eventId
    if (raw == null) return 0
    if (typeof raw === 'number') return raw
    const n = parseInt(String(raw), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}
