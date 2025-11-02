import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs'
import { filter, map, scan, share, distinctUntilChanged } from 'rxjs/operators'
import { ws } from '@/lib/ws/singleton'
import { chatTrace } from '@/lib/logger'

type WsEvent = { method: string; params: any }

type GenEntry = { generating: boolean; updatedAt: number; lastEventId: number }
type GenState = { byKey: Record<string, GenEntry>; version: number }

function now() {
  return Date.now()
}

function convKey(p: any): string | null {
  try {
    const cid = typeof p?.conversationId === 'string' ? (p.conversationId as string) : ''
    if (!cid) return null
    const pid =
      typeof (p as any)?.providerId === 'string'
        ? (p as any).providerId
        : typeof (p as any)?.provider === 'string'
          ? (p as any).provider
          : ''
    return pid ? `${pid}|${cid}` : cid
  } catch {
    return null
  }
}

function parseEventId(params: any): number {
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

const ON_METHODS = new Set([
  'chat.message.delta',
  'chat.reasoning.delta',
  'chat.tool.exec.begin',
  'chat.tool.patch.begin',
  'chat.tool.mcp.begin'
])
const OFF_METHODS = new Set(['chat.turn.complete', 'chat.message.failed', 'chat.message.aborted'])

function isCompactCompletedText(p: any): boolean {
  try {
    const t = String(p?.text || '').trim().toLowerCase()
    return t === 'compact task completed'
  } catch {
    return false
  }
}

function buildUpdates$(events$: Observable<WsEvent>) {
  return events$.pipe(
    filter((ev) => typeof ev?.method === 'string' && (ev.method.startsWith('chat.') || ev.method.startsWith('codex/'))),
    filter((ev) => ev.method.startsWith('chat.')),
    map((ev) => {
      const key = convKey(ev.params)
      const eid = parseEventId(ev.params)
      const m = ev.method
      if (!key) return null
      if (ON_METHODS.has(m)) return { key, eid, on: true as const }
      if (OFF_METHODS.has(m)) return { key, eid, on: false as const }
      if (m === 'chat.message.completed') {
        // 完整完成也视为“点火”，直到 turn.complete/failed/aborted 才关灯
        if (isCompactCompletedText(ev.params)) return null
        return { key, eid, on: true as const }
      }
      return null
    }),
    filter((x): x is { key: string; eid: number; on: boolean } => !!x),
    share()
  )
}

const state$ = new BehaviorSubject<GenState>({ byKey: {}, version: 0 })
let sub: Subscription | null = null
const seeds$ = new Subject<{ key: string; generating: boolean; lastEventId?: number }>()

export function initGlobalGeneratingAggregator() {
  if (sub) return () => stopGlobalGeneratingAggregator()
  const src = (ws as any).events$ as Observable<WsEvent>
  if (!src || typeof (src as any).pipe !== 'function') return () => {}

  const updates$ = buildUpdates$(src)
  const merged$ = new Observable<
    | { key: string; eid: number; on: boolean }
    | { seed: true; key: string; generating: boolean; lastEventId?: number }
  >((subscriber) => {
    const a = updates$.subscribe(subscriber)
    const b = seeds$.subscribe((s) => subscriber.next({ seed: true, ...s } as any))
    return () => {
      a.unsubscribe()
      b.unsubscribe()
    }
  })

  sub = merged$
    .pipe(
      scan((prev, cur) => {
        const next: GenState = { byKey: { ...prev.byKey }, version: prev.version }
        if ((cur as any).seed) {
          const { key, generating, lastEventId } = cur as any
          const old = next.byKey[key]
          const entry: GenEntry = {
            generating: !!generating,
            lastEventId: Math.max(0, Number(lastEventId || old?.lastEventId || 0)),
            updatedAt: now()
          }
          next.byKey[key] = entry
          next.version += 1
          return next
        }
        const { key, eid, on } = cur as { key: string; eid: number; on: boolean }
        const old = next.byKey[key]
        const oldEid = old?.lastEventId || 0
        if (eid > 0 && eid <= oldEid) return prev
        const entry: GenEntry = {
          generating: on ? true : false,
          lastEventId: eid > 0 ? eid : oldEid,
          updatedAt: now()
        }
        // 如果已处于 on 且收到重复 on，不增加 version
        if (old && old.generating === entry.generating && entry.lastEventId === old.lastEventId) {
          return prev
        }
        next.byKey[key] = entry
        next.version += 1
        return next
      }, state$.getValue()),
      distinctUntilChanged((a, b) => a.version === b.version)
    )
    .subscribe((s) => state$.next(s))

  chatTrace('gen-agg.init', {})
  return () => stopGlobalGeneratingAggregator()
}

export function stopGlobalGeneratingAggregator() {
  try {
    sub?.unsubscribe()
  } catch {}
  sub = null
}

export function seedGenerating(key: string, generating: boolean, lastEventId?: number) {
  seeds$.next({ key, generating, lastEventId })
}

export function generatingState$(): Observable<GenState> {
  return state$.asObservable()
}

export function getGeneratingSnapshot(): GenState {
  return state$.getValue()
}
