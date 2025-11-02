import { Observable, from, merge } from 'rxjs'
import {
  filter,
  groupBy,
  map,
  mergeMap,
  scan,
  startWith,
  toArray,
  windowToggle,
  withLatestFrom,
  share,
  distinctUntilChanged
} from 'rxjs/operators'

type WsEvent = { method: string; params: any }

const isChat = (m: string) => typeof m === 'string' && m.startsWith('chat.')
const isHandshake = (m: string) => m === 'chat.session.sync_begin' || m === 'chat.session.sync_end'
const cidOf = (p: any) =>
  typeof p?.conversationId === 'string' ? (p as any).conversationId : undefined
const eventIdOf = (p: any): number => {
  try {
    const raw = p?.eventId
    if (raw == null) return 0
    if (typeof raw === 'number') return raw
    const n = parseInt(String(raw), 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

export function buildChatPipeline(
  events$: Observable<WsEvent>,
  opts?: { enableBuffer?: boolean; strictBuffer?: boolean }
): { chat$: Observable<WsEvent>; syncEnd$: Observable<WsEvent> } {
  const source$ = events$.pipe(share())
  const enableBuffer = opts?.enableBuffer ?? true
  const strictBuffer = opts?.strictBuffer ?? false

  const syncBegin$ = source$.pipe(filter((ev) => ev.method === 'chat.session.sync_begin'))
  const syncEnd$ = source$.pipe(filter((ev) => ev.method === 'chat.session.sync_end'))
  const chat$ = source$.pipe(filter((ev) => isChat(ev.method) && !isHandshake(ev.method)))

  if (!enableBuffer) {
    return { chat$: chat$, syncEnd$ }
  }

  const chatGrouped$ = chat$.pipe(groupBy((ev) => cidOf(ev.params) || ''))
  let buffered$: Observable<WsEvent>

  if (!strictBuffer) {
    buffered$ = chatGrouped$.pipe(
      mergeMap((group$) => {
        const cid = group$.key
        if (!cid) return group$

        const beginForCid$ = syncBegin$.pipe(filter((e) => cidOf(e.params) === cid))
        const endForCid$ = syncEnd$.pipe(filter((e) => cidOf(e.params) === cid))

        // 是否处于握手期的布尔状态（会话级）
        const hydState$ = merge(
          beginForCid$.pipe(map(() => true)),
          endForCid$.pipe(map(() => false))
        ).pipe(startWith(false), share())

        // 握手窗口内：缓冲 → 排序 → 扁平
        const inWindowBatches$ = group$.pipe(
          windowToggle(beginForCid$, () => endForCid$),
          mergeMap((win$) =>
            win$.pipe(
              toArray(),
              map((arr) => arr.sort((a, b) => eventIdOf(a.params) - eventIdOf(b.params))),
              mergeMap((arr) => from(arr))
            )
          )
        )

        // 非握手窗口：实时直通
        const passThrough$ = group$.pipe(
          withLatestFrom(hydState$),
          filter(([_, hyd]) => !hyd),
          map(([ev]) => ev)
        )

        return merge(inWindowBatches$, passThrough$)
      })
    )
  } else {
    // 严格模式：任意会话握手期内，所有会话均不直通；全局窗口关闭后统一 flush（各自会话内按 eventId 升序）
    const beginAny$ = syncBegin$.pipe(map(() => 1))
    const endAny$ = syncEnd$.pipe(map(() => -1))
    const hydCount$ = merge(beginAny$, endAny$).pipe(
      startWith(0),
      scan((acc, d) => Math.max(0, acc + d), 0),
      distinctUntilChanged(),
      share()
    )
    const hydAny$ = hydCount$.pipe(map((c) => c > 0), distinctUntilChanged(), share())
    const open$ = hydAny$.pipe(filter((x) => x))
    const close$ = hydAny$.pipe(filter((x) => !x))

    buffered$ = chatGrouped$.pipe(
      mergeMap((group$) => {
        // 严格窗口：由“任意会话握手计数”的开启/关闭控制
        const inStrictWindows$ = group$.pipe(
          windowToggle(open$, () => close$),
          mergeMap((win$) =>
            win$.pipe(
              toArray(),
              map((arr) => arr.sort((a, b) => eventIdOf(a.params) - eventIdOf(b.params))),
              mergeMap((arr) => from(arr))
            )
          )
        )

        // 非全局握手窗口：实时直通
        const passWhenNoAny$ = group$.pipe(
          withLatestFrom(hydAny$),
          filter(([_, any]) => !any),
          map(([ev]) => ev)
        )

        return merge(inStrictWindows$, passWhenNoAny$)
      })
    )
  }

  return { chat$: buffered$, syncEnd$ }
}
