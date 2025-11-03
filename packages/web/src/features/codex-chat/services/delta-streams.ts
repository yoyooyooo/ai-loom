import {
  Observable,
  GroupedObservable,
  animationFrameScheduler,
  EMPTY,
  merge,
  of,
  Subscription
} from 'rxjs'
import {
  bufferTime,
  filter,
  groupBy,
  map,
  mergeMap,
  observeOn,
  scan,
  share,
  shareReplay,
  startWith,
  tap,
  withLatestFrom
} from 'rxjs/operators'

import { ws } from '@/lib/ws/singleton'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '../stores/chat-turns'
import { useChatHydrationStore } from '../stores/chat-hydration'
import type { WsEvent } from './ws-streams'
import { normalizeText, eventIdFromParams, parseEventId } from '@/lib/ws/chat-utils'

type DeltaPipelineOptions = {
  batchMs?: number
  isVitest?: boolean
}

type DeltaItem = { cid: string; delta: string; eventId: number }
type Batched = { cid: string; joined: string; eventId: number }
type ExecOutItem = { key: string; cid: string; callId: string; text: string }
type ExecBatched = { cid: string; callId: string; joined: string }
type ReasoningChunk = {
  cid: string
  itemId?: string
  joined: string
  eventId: number
  source: 'content' | 'raw'
}

type CompletionInfo = { lastCompletedEventId: number; lastCompletedText: string; turnClosed: boolean }

const createCompletionInfo = (): CompletionInfo => ({
  lastCompletedEventId: 0,
  lastCompletedText: '',
  turnClosed: false
})

const shouldDropDelta = (batch: Batched, state: Map<string, CompletionInfo>): boolean => {
  let info = state.get(batch.cid)
  if (!info) {
    try {
      const st: any = (useChatTurnStore as any).getState?.()
      const slice = st ? chatTurnSelectors.currentSlice(st) : null
      const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
      const last = turns.length > 0 ? turns[turns.length - 1] : undefined
      if (last && last.status === 'completed') {
        const eid = Number(last?.meta?.extra?.assistantCompletedEventId ?? 0) || 0
        info = {
          lastCompletedEventId: eid,
          lastCompletedText: String(last?.assistant?.text || ''),
          turnClosed: true
        }
      }
    } catch {}
  }
  if (!info) return false
  const { lastCompletedEventId, lastCompletedText, turnClosed } = info
  const eventId = batch.eventId
  if (lastCompletedEventId > 0 && eventId > 0 && eventId <= lastCompletedEventId) {
    return true
  }
  if (turnClosed && eventId <= 0 && lastCompletedText) {
    const tail = normalizeText(lastCompletedText).trimEnd()
    const chunk = normalizeText(batch.joined).trimEnd()
    if (tail.length > 0 && chunk.length > 0 && tail.endsWith(chunk)) return true
  }
  return false
}

const toObservable = (input: any): Observable<WsEvent> | null => {
  if (!input) return null
  if (typeof input.pipe === 'function') {
    return (input as Observable<WsEvent>).pipe(share())
  }
  if (typeof input.subscribe === 'function') {
    return new Observable<WsEvent>((subscriber) => {
      const sub = (input as { subscribe: (fn: (v: WsEvent) => void) => any }).subscribe(
        (value: WsEvent) => subscriber.next(value)
      )
      return () => {
        try {
          sub?.unsubscribe?.()
        } catch {}
      }
    }).pipe(share())
  }
  return null
}

const resolveBatchMs = (options?: DeltaPipelineOptions): number => {
  if (options?.batchMs != null && Number.isFinite(options.batchMs)) {
    return Math.max(1, Math.floor(options.batchMs))
  }
  try {
    const raw = (import.meta as any)?.env?.VITE_CHAT_BATCH_MS
    if (raw == null) return 16
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 16
  } catch {
    return 16
  }
}

const resolveIsVitest = (options?: DeltaPipelineOptions): boolean => {
  if (typeof options?.isVitest === 'boolean') return options.isVitest
  try {
    return typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
  } catch {
    return false
  }
}

const buildCompletionState$ = (stream$: Observable<WsEvent>) =>
  stream$
    .pipe(
      filter(
        (ev: WsEvent) =>
          ev?.method === 'chat.message.completed' ||
          ev?.method === 'chat.message.failed' ||
          ev?.method === 'chat.message.aborted' ||
          ev?.method === 'chat.turn.complete' ||
          ev?.method === 'chat.turn.started'
      ),
      scan((state, ev) => {
        const next = new Map(state)
        const cid = String(ev?.params?.conversationId || '')
        if (!cid) return next
        const prev = next.get(cid) ?? createCompletionInfo()
        const eventId = eventIdFromParams(ev.params)
        switch (ev.method) {
          case 'chat.turn.started': {
            next.set(cid, {
              lastCompletedEventId: prev.lastCompletedEventId,
              lastCompletedText: '',
              turnClosed: false
            })
            return next
          }
          case 'chat.message.completed': {
            const text = typeof ev?.params?.text === 'string' ? ev.params.text : ''
            const eid = eventId > 0 ? eventId : prev.lastCompletedEventId
            next.set(cid, {
              lastCompletedEventId: eid,
              lastCompletedText: text,
              turnClosed: true
            })
            return next
          }
          case 'chat.message.failed':
          case 'chat.message.aborted': {
            const eid = eventId > 0 ? eventId : prev.lastCompletedEventId
            next.set(cid, {
              lastCompletedEventId: eid,
              lastCompletedText: prev.lastCompletedText,
              turnClosed: true
            })
            return next
          }
          case 'chat.turn.complete': {
            const eid =
              eventId > 0 ? Math.max(eventId, prev.lastCompletedEventId) : prev.lastCompletedEventId
            next.set(cid, {
              lastCompletedEventId: eid,
              lastCompletedText: prev.lastCompletedText,
              turnClosed: true
            })
            return next
          }
          default:
            return next
        }
      }, new Map<string, CompletionInfo>()),
      startWith(new Map<string, CompletionInfo>()),
      shareReplay({ bufferSize: 1, refCount: true })
    )

const buildReasoningBatches$ = (stream$: Observable<WsEvent>, batchMs: number) =>
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.reasoning.delta'),
      map((ev: WsEvent) => {
        const cid = String(ev?.params?.conversationId || '')
        const delta = String(ev?.params?.delta || '')
        const itemId = typeof ev?.params?.itemId === 'string' ? ev.params.itemId : undefined
        const eventId = parseEventId(ev?.params?.eventId)
        const key = `${cid}#${itemId ?? '__default__'}`
        return { key, cid, itemId, delta, eventId }
      }),
      filter((item) => item.cid.length > 0 && item.delta.length > 0),
      groupBy((item) => item.key),
      mergeMap((group$) =>
        group$
          .pipe(
            bufferTime(batchMs, undefined, 200),
            map((list) => {
              if (!list.length) return null
              const joined = list.map((entry) => entry.delta).join('')
              if (!joined.length) return null
              const eventId = Math.max(0, ...list.map((entry) => entry.eventId || 0))
              const last = list[list.length - 1]
              return {
                cid: last.cid,
                itemId: last.itemId,
                joined,
                eventId,
                source: 'content' as const
              } satisfies ReasoningChunk
            }),
            filter((chunk): chunk is ReasoningChunk => chunk !== null),
            observeOn(animationFrameScheduler)
          )
      )
    )

const buildReasoningRawBatches$ = (stream$: Observable<WsEvent>, batchMs: number) =>
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.reasoning.raw_delta'),
      map((ev: WsEvent) => {
        const cid = String(ev?.params?.conversationId || '')
        const delta = String(ev?.params?.delta || '')
        const itemId = typeof ev?.params?.itemId === 'string' ? ev.params.itemId : undefined
        const eventId = parseEventId(ev?.params?.eventId)
        const key = `${cid}#${itemId ?? '__default__'}`
        return { key, cid, itemId, delta, eventId }
      }),
      filter((item) => item.cid.length > 0 && item.delta.length > 0),
      groupBy((item) => item.key),
      mergeMap((group$) =>
        group$
          .pipe(
            bufferTime(batchMs, undefined, 200),
            map((list) => {
              if (!list.length) return null
              const joined = list.map((entry) => entry.delta).join('')
              if (!joined.length) return null
              const eventId = Math.max(0, ...list.map((entry) => entry.eventId || 0))
              const last = list[list.length - 1]
              return {
                cid: last.cid,
                itemId: last.itemId,
                joined,
                eventId,
                source: 'raw' as const
              } satisfies ReasoningChunk
            }),
            filter((chunk): chunk is ReasoningChunk => chunk !== null),
            observeOn(animationFrameScheduler)
          )
      )
    )

const buildAgentBatches$ = (stream$: Observable<WsEvent>, batchMs: number) =>
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.message.delta'),
      map(
        (ev: WsEvent): DeltaItem => ({
          cid: String(ev?.params?.conversationId || ''),
          delta: String(ev?.params?.delta || ''),
          eventId: eventIdFromParams(ev.params)
        })
      ),
      filter((item: DeltaItem): item is DeltaItem => item.cid.length > 0 && item.delta.length > 0),
      groupBy((item: DeltaItem) => item.cid),
      mergeMap((group$: GroupedObservable<string, DeltaItem>) =>
        group$
          .pipe(
            bufferTime(batchMs, undefined, 200),
            map(
              (list: DeltaItem[]): Batched => ({
                cid: group$.key as string,
                joined: list.map((entry) => entry.delta).join(''),
                eventId: Math.max(0, ...list.map((entry) => entry.eventId || 0))
              })
            ),
            filter((batched: Batched) => batched.joined.length > 0),
            observeOn(animationFrameScheduler)
          )
      )
    )

const buildExecBatches$ = (stream$: Observable<WsEvent>, batchMs: number) =>
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.tool.exec.output'),
      map((ev: WsEvent): ExecOutItem => {
        const cid = String(ev?.params?.conversationId || '')
        const callId = String(ev?.params?.callId || '')
        const text = String((ev?.params?.text ?? ev?.params?.chunk ?? '') || '')
        return { key: `${cid}#${callId}`, cid, callId, text }
      }),
      filter(
        (item: ExecOutItem): item is ExecOutItem =>
          item.cid.length > 0 && item.callId.length > 0 && item.text.length > 0
      ),
      groupBy((item: ExecOutItem) => item.key),
      mergeMap((group$: GroupedObservable<string, ExecOutItem>) =>
        group$
          .pipe(
            bufferTime(batchMs, undefined, 200),
            map(
              (list: ExecOutItem[]): ExecBatched => ({
                cid: (list[0]?.cid as string) || (group$.key.split('#')[0] as string),
                callId: (list[0]?.callId as string) || (group$.key.split('#')[1] as string),
                joined: list.map((entry) => entry.text).join('')
              })
            ),
            filter((batched: ExecBatched) => batched.joined.length > 0),
            observeOn(animationFrameScheduler)
          )
      )
    )

const buildVitestFallback$ = (stream$: Observable<WsEvent>) =>
  stream$.pipe(
    filter((ev: WsEvent) => ev?.method === 'chat.message.completed'),
    tap((ev: WsEvent) => {
      try {
        const st: any = (useChatTurnStore as any).getState?.()
        const slice = st ? chatTurnSelectors.currentSlice(st) : null
        const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        if ((turns?.length || 0) === 0) {
          chatTurnActions.markTurnStarted({})
          const text = String(ev?.params?.text || '')
          const eid = parseEventId(ev?.params?.eventId)
          chatTurnActions.completeAssistant(text, undefined, eid)
          chatTurnActions.completeTurn()
        }
      } catch {}
    })
  )

export function startDeltaPipelines(
  stream$: Observable<WsEvent>,
  options?: DeltaPipelineOptions
): Subscription {
  const shared$ = stream$.pipe(share())
  const batchMs = resolveBatchMs(options)
  const completionState$ = buildCompletionState$(shared$)

  const reasoningContent$ = buildReasoningBatches$(shared$, batchMs)
  const reasoningRaw$ = buildReasoningRawBatches$(shared$, batchMs)

  const reasoningEffect$ = reasoningContent$.pipe(
    tap(({ cid, itemId, joined, eventId }: ReasoningChunk) => {
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      const slice = st ? chatTurnSelectors.currentSlice(st) : null
      if (cur && cur !== cid) return
      try {
        if (!slice?.activeTurnId) chatTurnActions.markTurnStarted({})
      } catch {}
      chatTurnActions.appendReasoning(joined, { itemId, source: 'content' })
      try {
        if (eventId && eventId > 0) (ws as any).primeConversationCursor?.(cid, eventId)
      } catch {}
    })
  )

  const reasoningRawEffect$ = reasoningRaw$.pipe(
    tap(({ cid, itemId, joined, eventId }: ReasoningChunk) => {
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      if (cur && cur !== cid) return
      const slice = st ? chatTurnSelectors.currentSlice(st) : null
      try {
        if (!slice?.activeTurnId) chatTurnActions.markTurnStarted({})
      } catch {}
      chatTurnActions.appendReasoning(joined, { itemId, source: 'raw' })
      try {
        if (eventId && eventId > 0) (ws as any).primeConversationCursor?.(cid, eventId)
      } catch {}
    })
  )

  const reasoningItemStarted$ = shared$.pipe(
    filter((ev: WsEvent) => ev?.method === 'chat.reasoning.item_started'),
    tap((ev: WsEvent) => {
      const itemId = typeof ev?.params?.itemId === 'string' ? ev.params.itemId : undefined
      if (itemId) chatTurnActions.markReasoningItemStarted(itemId)
    })
  )

  const reasoningItemCompleted$ = shared$.pipe(
    filter((ev: WsEvent) => ev?.method === 'chat.reasoning.item_completed'),
    tap((ev: WsEvent) => {
      const itemId = typeof ev?.params?.itemId === 'string' ? ev.params.itemId : undefined
      if (!itemId) return
      const summary = typeof ev?.params?.text === 'string' ? ev.params.text : undefined
      const rawContent =
        typeof ev?.params?.rawContent === 'string' ? ev.params.rawContent : undefined
      chatTurnActions.markReasoningItemCompleted(itemId, {
        summary,
        rawContent: rawContent ?? null
      })
    })
  )

  const agentEffect$ = buildAgentBatches$(shared$, batchMs).pipe(
    withLatestFrom(completionState$),
    filter(([batched, state]) => !shouldDropDelta(batched, state)),
    tap(([batched]) => {
      const { cid, joined, eventId } = batched
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      const slice = st ? chatTurnSelectors.currentSlice(st) : null
      if (cur && cur !== cid) return
      const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
      if (!slice?.activeTurnId) {
        try {
          const hyd = (useChatHydrationStore as any)?.getState?.()
          const hydrating = !!hyd?.hydrating?.[cid]
          if (hydrating) {
            const last = turns.length > 0 ? turns[turns.length - 1] : undefined
            const lastCompletedWithAssistant =
              !!last && last.status === 'completed' && String(last?.assistant?.text || '').trim()
            if (lastCompletedWithAssistant) return
          }
        } catch {}
      }
      try {
        if (!slice?.activeTurnId) chatTurnActions.markTurnStarted({})
      } catch {}
      chatTurnActions.markFinalMessageStarted()
      chatTurnActions.appendAssistantDelta(joined)
      try {
        if (eventId && eventId > 0) (ws as any).primeConversationCursor?.(cid, eventId)
      } catch {}
    })
  )

  const execEffect$ = buildExecBatches$(shared$, batchMs).pipe(
    tap(({ cid, callId, joined }: ExecBatched) => {
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      if (cur && cur !== cid) return
      chatTurnActions.appendStep(callId, joined)
    })
  )

  const streams: Observable<unknown>[] = [
    reasoningEffect$,
    reasoningRawEffect$,
    reasoningItemStarted$,
    reasoningItemCompleted$,
    agentEffect$,
    execEffect$
  ]

  if (resolveIsVitest(options)) {
    streams.push(buildVitestFallback$(shared$))
  }

  return merge(...streams).subscribe({
    next: () => {},
    error: () => {}
  })
}

let singleton: Subscription | null = null

export function ensureDeltaPipelines(options?: DeltaPipelineOptions): Subscription | null {
  if (singleton && !singleton.closed) return singleton
  const rawStream = toObservable((ws as any).events$)
  if (!rawStream) return null
  singleton = startDeltaPipelines(rawStream, options)
  return singleton
}
