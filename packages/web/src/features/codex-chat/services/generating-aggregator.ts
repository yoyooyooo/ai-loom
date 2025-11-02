import { BehaviorSubject, Observable, Subject, Subscription } from 'rxjs'
import { filter, map, scan, share, distinctUntilChanged, mergeMap } from 'rxjs/operators'
import { ws } from '@/lib/ws/singleton'
import { chatTrace } from '@/lib/logger'

type WsEvent = { method: string; params: any }

type GenEntry = { generating: boolean; updatedAt: number; lastEventId: number }
type GenState = { byKey: Record<string, GenEntry>; version: number }
type RuntimeUpdate = { key: string; eid: number; generating: boolean }
type SeedUpdate = { seed: true; key: string; generating: boolean; lastEventId?: number }

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

function buildUpdates$(events$: Observable<WsEvent>): Observable<RuntimeUpdate> {
  return events$.pipe(
    filter((ev) => typeof ev?.method === 'string'),
    mergeMap<WsEvent, RuntimeUpdate[]>((ev) => {
      const method = ev.method
      if (method === 'chat.info.runtime.generating') {
        const key = convKey(ev.params)
        if (!key) return [] as RuntimeUpdate[]
        const eid = parseEventId(ev.params)
        const generating = !!ev.params?.generating
        return [{ key, eid, generating }] as RuntimeUpdate[]
      }
      if (method === 'session.runtime') {
        const items = Array.isArray((ev.params as any)?.items) ? (ev.params as any).items : []
        return items
          .map((item: any) => {
            const key = convKey(item)
            if (!key) return null
            const eid = parseEventId(item)
            const generating = !!item?.generating
            return { key, eid, generating } as RuntimeUpdate
          })
          .filter((entry: RuntimeUpdate | null): entry is RuntimeUpdate => entry !== null)
      }
      return [] as RuntimeUpdate[]
    }),
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
  const merged$ = new Observable<RuntimeUpdate | SeedUpdate>((subscriber) => {
    const a = updates$.subscribe((value) => subscriber.next(value))
    const b = seeds$.subscribe((seed) =>
      subscriber.next({ seed: true, ...seed } as SeedUpdate)
    )
    return () => {
      a.unsubscribe()
      b.unsubscribe()
    }
  })

  sub = merged$
    .pipe(
      scan((prev, cur) => {
        const next: GenState = { byKey: { ...prev.byKey }, version: prev.version }
        if ('seed' in cur && cur.seed) {
          const { key, generating, lastEventId } = cur
          const old = next.byKey[key]
          const eid = Math.max(0, Number(lastEventId || old?.lastEventId || 0))
          if (generating) {
            const entry: GenEntry = {
              generating: true,
              lastEventId: eid,
              updatedAt: now()
            }
            next.byKey[key] = entry
          } else {
            delete next.byKey[key]
          }
          next.version += 1
          return next
        }
        const { key, eid, generating } = cur as RuntimeUpdate
        const old = next.byKey[key]
        const oldEid = old?.lastEventId || 0
        if (eid > 0 && eid <= oldEid) return prev
        if (generating) {
          const entry: GenEntry = {
            generating: true,
            lastEventId: eid > 0 ? eid : oldEid,
            updatedAt: now()
          }
          if (old && old.generating === entry.generating && entry.lastEventId === old.lastEventId) {
            return prev
          }
          next.byKey[key] = entry
          next.version += 1
        } else {
          if (old) {
            delete next.byKey[key]
            next.version += 1
          }
        }
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
