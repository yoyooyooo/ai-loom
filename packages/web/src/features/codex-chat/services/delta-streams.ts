import { animationFrameScheduler, Observable, GroupedObservable } from 'rxjs'
import { bufferTime, filter, groupBy, map, mergeMap, observeOn, share } from 'rxjs/operators'
import { ws } from '@/lib/ws/singleton'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'

let inited = false
const DEFAULT_BATCH_MS = (() => {
  try {
    const v = (import.meta as any).env?.VITE_CHAT_BATCH_MS
    if (v == null) return 16
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 16
  } catch {
    return 16
  }
})()

type WsEvent = { method: string; params: any }
type DeltaItem = { cid: string; delta: string }
type Batched = { cid: string; joined: string }

export function ensureDeltaPipelines() {
  if (inited) return
  inited = true

  const batchMs = DEFAULT_BATCH_MS
  const raw: any = (ws as any).events$
  let stream$: Observable<WsEvent>
  if (raw && typeof raw.pipe === 'function') {
    stream$ = (raw as Observable<WsEvent>).pipe(share())
  } else if (raw && typeof raw.subscribe === 'function') {
    stream$ = new Observable<WsEvent>((subscriber) => {
      const sub = (raw as { subscribe: (h: (v: WsEvent) => void) => any }).subscribe((v: WsEvent) =>
        subscriber.next(v)
      )
      return () => {
        try {
          sub?.unsubscribe?.()
        } catch {}
      }
    }).pipe(share())
  } else {
    return
  }

  // Reasoning delta 微批
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.reasoning.delta'),
      map((ev: WsEvent): DeltaItem => ({
        cid: String(ev?.params?.conversationId || ''),
        delta: String(ev?.params?.delta || '')
      })),
      filter((e: DeltaItem): e is DeltaItem => e.cid.length > 0 && e.delta.length > 0),
      groupBy((e: DeltaItem) => e.cid),
      mergeMap((g$: GroupedObservable<string, DeltaItem>) =>
        g$.pipe(
          bufferTime(batchMs, undefined, 200),
          map((list: DeltaItem[]): Batched => ({ cid: g$.key as string, joined: list.map((x) => x.delta).join('') })),
          filter((p: Batched) => p.joined.length > 0),
          observeOn(animationFrameScheduler)
        )
      )
    )
    .subscribe(({ cid, joined }: Batched) => {
      // 仅在当前会话活跃时才落地
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      if (cur && cur !== cid) return
      // 缺失 turn.started 的隐式开启（规范：首条内容事件触发 beginTurn）
      try {
        if (!st?.activeTurnId) chatTurnActions.markTurnStarted({})
      } catch {}
      chatTurnActions.appendReasoning(joined)
    })

  // Agent message delta 微批
  stream$
    .pipe(
      filter((ev: WsEvent): ev is WsEvent => ev?.method === 'chat.message.delta'),
      map((ev: WsEvent): DeltaItem => ({
        cid: String(ev?.params?.conversationId || ''),
        delta: String(ev?.params?.delta || '')
      })),
      filter((e: DeltaItem): e is DeltaItem => e.cid.length > 0 && e.delta.length > 0),
      groupBy((e: DeltaItem) => e.cid),
      mergeMap((g$: GroupedObservable<string, DeltaItem>) =>
        g$.pipe(
          bufferTime(batchMs, undefined, 200),
          map((list: DeltaItem[]): Batched => ({ cid: g$.key as string, joined: list.map((x) => x.delta).join('') })),
          filter((p: Batched) => p.joined.length > 0),
          observeOn(animationFrameScheduler)
        )
      )
    )
    .subscribe(({ cid, joined }: Batched) => {
      const st: any = (useChatTurnStore as any).getState?.()
      const cur = st?.conversationId
      if (cur && cur !== cid) return
      // 缺失 turn.started 的隐式开启（规范：首条内容事件触发 beginTurn）
      try {
        if (!st?.activeTurnId) chatTurnActions.markTurnStarted({})
      } catch {}
      chatTurnActions.appendAssistantDelta(joined)
    })
}
