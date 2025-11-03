import { Observable, Subscription } from 'rxjs'
import { filter, scan, share, distinctUntilChanged, mergeMap } from 'rxjs/operators'
import { ws } from '@/lib/ws/singleton'
import { chatTrace } from '@/lib/logger'
import {
  generatingSeed$$,
  generatingState$$,
  type GenEntry,
  type GenState,
  type GenSeedPayload
} from '@/lib/ws/runtime-subjects'
import { parseEventId } from '@/lib/ws/chat-utils'

type WsEvent = { method: string; params: any }

type RuntimeUpdate = { kind: 'runtime'; key: string; eid: number; generating: boolean }
type PendingUpdate = { kind: 'pending'; key: string; eid: number; pending: boolean }
type SeedUpdate = GenSeedPayload & { kind: 'seed' }

type UpdateEvent = RuntimeUpdate | PendingUpdate | SeedUpdate

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

function buildUpdates$(events$: Observable<WsEvent>): Observable<UpdateEvent> {
  return events$.pipe(
    filter((ev) => typeof ev?.method === 'string'),
    mergeMap<WsEvent, UpdateEvent[]>((ev) => {
      const method = ev.method
      if (method === 'chat.info.runtime.generating') {
        const key = convKey(ev.params)
        if (!key) return [] as UpdateEvent[]
        const eid = parseEventId(ev.params)
        const generating = !!ev.params?.generating
        return [{ kind: 'runtime', key, eid, generating }] as UpdateEvent[]
      }
      if (method === 'session.runtime') {
        const items = Array.isArray((ev.params as any)?.items) ? (ev.params as any).items : []
        return items
          .map((item: any) => {
            const key = convKey(item)
            if (!key) return null
            const eid = parseEventId(item)
            const generating = !!item?.generating
            return { kind: 'runtime', key, eid, generating } as RuntimeUpdate
          })
          .filter((entry: RuntimeUpdate | null): entry is RuntimeUpdate => entry !== null)
      }
      if (method === 'chat.message.aborted') {
        const key = convKey(ev.params)
        if (!key) return []
        const eid = parseEventId(ev.params)
        return [
          { kind: 'pending', key, eid, pending: false },
          { kind: 'runtime', key, eid, generating: false }
        ]
      }
      if (
        method === 'chat.turn.started' ||
        method === 'chat.message.delta' ||
        method === 'chat.message.completed' ||
        method === 'chat.message.failed'
      ) {
        const key = convKey(ev.params)
        if (!key) return []
        const eid = parseEventId(ev.params)
        return [{ kind: 'pending', key, eid, pending: true }]
      }
      if (method === 'chat.turn.complete') {
        const key = convKey(ev.params)
        if (!key) return []
        const eid = parseEventId(ev.params)
        return [{ kind: 'pending', key, eid, pending: false }]
      }
      return [] as UpdateEvent[]
    }),
    share()
  )
}

let sub: Subscription | null = null
let globalRuntimeSub: Subscription | null = null

export function initGlobalGeneratingAggregator() {
  if (sub) return () => stopGlobalGeneratingAggregator()
  const src = (ws as any).events$ as Observable<WsEvent>
  if (!src || typeof (src as any).pipe !== 'function') return () => {}

  if (!globalRuntimeSub) {
    try {
      globalRuntimeSub = ws
        .subscribeTopic$('chat', {
          methods: [
            'chat.info.runtime.generating',
            'session.runtime',
            'chat.turn.started',
            'chat.turn.complete',
            'chat.message.delta',
            'chat.message.completed',
            'chat.message.failed',
            'chat.message.aborted'
          ]
        })
        .subscribe(() => {})
    } catch {
      globalRuntimeSub = null
    }
  }

  const updates$ = buildUpdates$(src)
  const merged$ = new Observable<UpdateEvent>((subscriber) => {
    const a = updates$.subscribe((value) => subscriber.next(value))
    const b = generatingSeed$$.subscribe((seed) =>
      subscriber.next({ kind: 'seed', ...seed } as SeedUpdate)
    )
    return () => {
      a.unsubscribe()
      b.unsubscribe()
    }
  })

  const runtimeMap = new Map<string, { generating: boolean; lastEventId: number }>()
  const pendingMap = new Map<string, { pending: boolean; lastEventId: number }>()

  sub = merged$
    .pipe(
      scan((prev, cur) => {
        const next: GenState = { byKey: { ...prev.byKey }, version: prev.version }
        const touched = new Set<string>()

        const applyStateForKey = (key: string) => {
          touched.add(key)
        }

        const setRuntime = (key: string, eid: number, generating: boolean) => {
          const prevEntry = runtimeMap.get(key)
          if (eid > 0 && prevEntry && prevEntry.lastEventId >= eid) return
          runtimeMap.set(key, { generating, lastEventId: eid > 0 ? eid : prevEntry?.lastEventId ?? 0 })
          if (!generating) {
            const pending = pendingMap.get(key)
            if (pending && !pending.pending) {
              // keep last eid but ensure pending flagged as false
              pendingMap.set(key, { pending: false, lastEventId: pending.lastEventId })
            }
          }
          applyStateForKey(key)
        }

        const setPending = (key: string, eid: number, pending: boolean) => {
          const prevEntry = pendingMap.get(key)
          if (eid > 0 && prevEntry && prevEntry.lastEventId > eid) {
            return
          }
          pendingMap.set(key, {
            pending,
            lastEventId: eid > 0 ? eid : prevEntry?.lastEventId ?? 0
          })
          if (!pending) {
            const prevRuntime = runtimeMap.get(key)
            const baseEid = Math.max(prevRuntime?.lastEventId ?? 0, eid > 0 ? eid : 0)
            if (!prevRuntime || prevRuntime.generating || prevRuntime.lastEventId < baseEid) {
              runtimeMap.set(key, { generating: false, lastEventId: baseEid })
            }
          }
          applyStateForKey(key)
        }

        if (cur.kind === 'seed') {
          const { key, generating, lastEventId } = cur
          const eid = Math.max(0, Number(lastEventId || runtimeMap.get(key)?.lastEventId || 0))
          setRuntime(key, eid, generating)
          if (!generating) {
            setPending(key, eid, false)
          }
        } else if (cur.kind === 'runtime') {
          setRuntime(cur.key, cur.eid, cur.generating)
        } else if (cur.kind === 'pending') {
          setPending(cur.key, cur.eid, cur.pending)
        }

        if (touched.size === 0) return prev

        let versionChanged = false
        touched.forEach((key) => {
          const runtimeState = runtimeMap.get(key)
          const pendingState = pendingMap.get(key)
          const shouldGenerate = !!(runtimeState?.generating) || !!(pendingState?.pending)
          const runtimeEid = runtimeState?.lastEventId ?? 0
          const pendingEid =
            pendingState && pendingState.pending ? pendingState.lastEventId ?? 0 : 0
          const lastEventId = Math.max(runtimeEid, pendingEid)
          const old = next.byKey[key]
          if (shouldGenerate) {
            const effectiveEid = lastEventId > 0 ? lastEventId : old?.lastEventId ?? 0
            if (!old || !old.generating || old.lastEventId !== effectiveEid) {
              const entry: GenEntry = {
                generating: true,
                lastEventId: effectiveEid,
                updatedAt: now()
              }
              next.byKey[key] = entry
              versionChanged = true
            }
          } else if (old) {
            delete next.byKey[key]
            versionChanged = true
          }
          if (!shouldGenerate) {
            runtimeMap.set(key, { generating: false, lastEventId: runtimeEid })
            pendingMap.set(key, { pending: false, lastEventId: pendingState?.lastEventId ?? 0 })
          }
        })

        if (versionChanged) {
          next.version += 1
          return next
        }
        return next
      }, generatingState$$.getValue()),
      distinctUntilChanged((a, b) => a.version === b.version)
    )
    .subscribe((s) => generatingState$$.next(s))

  chatTrace('gen-agg.init', {})
  return () => stopGlobalGeneratingAggregator()
}

export function stopGlobalGeneratingAggregator() {
  try {
    sub?.unsubscribe()
  } catch {}
  sub = null
  try {
    globalRuntimeSub?.unsubscribe()
  } catch {}
  globalRuntimeSub = null
}

export function seedGenerating(key: string, generating: boolean, lastEventId?: number) {
  generatingSeed$$.next({ key, generating, lastEventId })
}

export function generatingState$(): Observable<GenState> {
  return generatingState$$.asObservable()
}

export function getGeneratingSnapshot(): GenState {
  return generatingState$$.getValue()
}
