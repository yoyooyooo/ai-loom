import { Observable, forkJoin, from, merge, partition, race, timer } from 'rxjs'
import { filter, map, mergeMap, scan, share, shareReplay, take } from 'rxjs/operators'

import { getConversationId } from '@/lib/ws/chat-utils'

export type WsEvent = { method: string; params: any }

export type WsEventHub = {
  source$: Observable<WsEvent>
  chat$: Observable<WsEvent>
  codex$: Observable<WsEvent>
  syncBegin$: Observable<WsEvent>
  syncEnd$: Observable<WsEvent>
}

const isChat = (method: string) => typeof method === 'string' && method.startsWith('chat.')
const isCodex = (method: string) => typeof method === 'string' && method.startsWith('codex/')
const isSyncBegin = (method: string) => method === 'chat.session.sync_begin'
const isSyncEnd = (method: string) => method === 'chat.session.sync_end'

export function createWsEventHub(events$: Observable<WsEvent>): WsEventHub {
  const source$ = events$.pipe(shareReplay({ bufferSize: 1, refCount: true }))
  const [chat$, nonChat$] = partition(source$, (ev) => isChat(ev.method))
  const codex$ = nonChat$.pipe(filter((ev) => isCodex(ev.method)), share())
  const chatShared$ = chat$.pipe(share())
  const syncBegin$ = chatShared$.pipe(filter((ev) => isSyncBegin(ev.method)), share())
  const syncEnd$ = chatShared$.pipe(filter((ev) => isSyncEnd(ev.method)), share())

  return {
    source$,
    chat$: chatShared$,
    codex$,
    syncBegin$,
    syncEnd$
  }
}

export type HydrationEffect =
  | { kind: 'set'; cid: string }
  | { kind: 'clear'; cid: string }
  | { kind: 'prime'; cid: string; upto: number }

type HydrationAction =
  | { type: 'begin'; cid: string; time: number }
  | { type: 'end'; cid: string; upto: number; time: number }

const defaultMinHold = 200

export function createHydrationEffects$(opts: {
  syncBegin$: Observable<WsEvent>
  syncEnd$: Observable<WsEvent>
  chat$: Observable<WsEvent>
  minHoldMs?: number
  clearFallbackMs?: number
}): Observable<HydrationEffect> {
  const minHoldMs =
    typeof opts.minHoldMs === 'number' && opts.minHoldMs >= 0 ? opts.minHoldMs : defaultMinHold
  const fallbackExtra =
    typeof opts.clearFallbackMs === 'number' && opts.clearFallbackMs >= 0
      ? opts.clearFallbackMs
      : Math.max(200, minHoldMs)

  const buildBegin$ = opts.syncBegin$.pipe(
    map((ev): HydrationAction | null => {
      const cid = getConversationId(ev.params)
      if (!cid) return null
      return { type: 'begin', cid, time: Date.now() }
    }),
    filter((action): action is HydrationAction => action !== null)
  )

  const buildEnd$ = opts.syncEnd$.pipe(
    map((ev): HydrationAction | null => {
      const cid = getConversationId(ev.params)
      if (!cid) return null
      const upto = Number(ev.params?.uptoEventId ?? 0) || 0
      return { type: 'end', cid, upto, time: Date.now() }
    }),
    filter((action): action is HydrationAction => action !== null)
  )

  type ClearWait = {
    type: 'clear_wait'
    cid: string
    hold: number
    fallback: number
  }

  type Acc = {
    startedAt: Map<string, number>
    effects: Array<HydrationEffect | ClearWait>
  }

  const initial: Acc = { startedAt: new Map(), effects: [] }

  return merge(buildBegin$, buildEnd$).pipe(
    scan<HydrationAction, Acc>((state, action) => {
      const startedAt = new Map(state.startedAt)
      const effects: Acc['effects'] = []

      if (action.type === 'begin') {
        startedAt.set(action.cid, action.time)
        effects.push({ kind: 'set', cid: action.cid })
      } else {
        const prev = startedAt.get(action.cid)
        if (prev) startedAt.delete(action.cid)
        const elapsed = prev ? action.time - prev : minHoldMs
        const delay = Math.max(0, minHoldMs - elapsed)
        const upto = Math.max(0, action.upto)
        if (upto > 0) {
          effects.push({ kind: 'prime', cid: action.cid, upto })
        }
        const fallback = delay + fallbackExtra
        effects.push({ type: 'clear_wait', cid: action.cid, hold: delay, fallback })
      }

      return { startedAt, effects }
    }, initial),
    mergeMap(({ effects }) => {
      const streams: Observable<HydrationEffect>[] = []

      for (const effect of effects) {
        if ((effect as ClearWait).type === 'clear_wait') {
          const { cid, hold, fallback } = effect as ClearWait
          const waitForEvent$ = opts.chat$.pipe(
            filter((ev) => getConversationId(ev.params) === cid),
            take(1),
            map(() => true)
          )
          const fallback$ = timer(Math.max(0, fallback)).pipe(map(() => false))
          const clear$ = forkJoin({
            _ready: race(waitForEvent$, fallback$),
            _hold: timer(Math.max(0, hold))
          }).pipe(map(() => ({ kind: 'clear', cid } as HydrationEffect)))
          streams.push(clear$)
        } else {
          streams.push(from([effect as HydrationEffect]))
        }
      }

      return merge(...streams)
    }),
    share()
  )
}
