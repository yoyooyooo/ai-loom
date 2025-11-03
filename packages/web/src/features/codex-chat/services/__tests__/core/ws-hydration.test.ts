import { describe, it, expect, vi, afterEach } from 'vitest'
import { Subject } from 'rxjs'

import {
  createHydrationEffects$,
  type HydrationEffect,
  type WsEvent
} from '@/features/codex-chat/services/ws-streams'

describe('ws hydration effects', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('begin/end 事件遵循最小停留时间并 prime 游标', () => {
    vi.useFakeTimers()
    const begin$$ = new Subject<WsEvent>()
    const end$$ = new Subject<WsEvent>()
    const chat$$ = new Subject<WsEvent>()
    const effects: HydrationEffect[] = []

    const sub = createHydrationEffects$({
      syncBegin$: begin$$,
      syncEnd$: end$$,
      chat$: chat$$,
      minHoldMs: 120,
      clearFallbackMs: 240
    }).subscribe((effect) => effects.push(effect))

    begin$$.next({ method: 'chat.session.sync_begin', params: { conversationId: 'conv-1' } })
    expect(effects).toEqual([{ kind: 'set', cid: 'conv-1' }])

    end$$.next({ method: 'chat.session.sync_end', params: { conversationId: 'conv-1', uptoEventId: 42 } })
    expect(effects.some((e) => e.kind === 'prime' && e.upto === 42)).toBe(true)
    expect(effects.every((e) => e.kind !== 'clear')).toBe(true)

    vi.advanceTimersByTime(60)
    chat$$.next({ method: 'chat.message.delta', params: { conversationId: 'conv-1' } })
    vi.advanceTimersByTime(60)
    expect(effects.some((e) => e.kind === 'clear' && e.cid === 'conv-1')).toBe(true)

    sub.unsubscribe()
  })

  it('end 事件未提供 eventId 时仍只触发 set/clear', () => {
    vi.useFakeTimers()
    const begin$$ = new Subject<WsEvent>()
    const end$$ = new Subject<WsEvent>()
    const chat$$ = new Subject<WsEvent>()
    const effects: HydrationEffect[] = []

    const sub = createHydrationEffects$({
      syncBegin$: begin$$,
      syncEnd$: end$$,
      chat$: chat$$,
      minHoldMs: 0,
      clearFallbackMs: 200
    }).subscribe((effect) => effects.push(effect))

    begin$$.next({ method: 'chat.session.sync_begin', params: { conversationId: 'conv-2' } })
    end$$.next({ method: 'chat.session.sync_end', params: { conversationId: 'conv-2', uptoEventId: 0 } })

    expect(effects.filter((e) => e.kind === 'set').length).toBe(1)
    expect(effects.filter((e) => e.kind === 'clear').length).toBe(0)
    vi.advanceTimersByTime(200)
    expect(effects.filter((e) => e.kind === 'clear').length).toBe(1)
    expect(effects.some((e) => e.kind === 'prime')).toBe(false)

    sub.unsubscribe()
  })
})
