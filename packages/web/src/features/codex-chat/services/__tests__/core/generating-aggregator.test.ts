import { describe, it, expect, vi } from 'vitest'
import type { Observable } from 'rxjs'
import {
  generatingState$,
  initGlobalGeneratingAggregator,
  stopGlobalGeneratingAggregator
} from '@/features/codex-chat/services/generating-aggregator'

// 提供最小的 ws 单例桩（使用 hoisted，避免 hoist 顺序问题）
const hoisted = vi.hoisted(() => {
  const { Subject } = require('rxjs')
  const src$$: any = new Subject()
  return { src$$ }
})
vi.mock('@/lib/ws/singleton', () => ({
  ws: {
    events$: (hoisted.src$$ as any).asObservable() as Observable<{ method: string; params: any }>
  }
}))

describe('generating-aggregator', () => {
  it('updates state via runtime events', async () => {
    const stop = initGlobalGeneratingAggregator()
    const observed: any[] = []
    const sub = generatingState$().subscribe((s) => observed.push(s))

    hoisted.src$$.next({
      method: 'session.runtime',
      params: {
        items: [
          { provider: 'codex', conversationId: 'A', generating: true },
          { provider: 'codex', conversationId: 'B', generating: false }
        ]
      }
    })

    hoisted.src$$.next({
      method: 'chat.info.runtime.generating',
      params: { provider: 'codex', conversationId: 'B', generating: true, eventId: 10 }
    })
    hoisted.src$$.next({
      method: 'chat.info.runtime.generating',
      params: { provider: 'codex', conversationId: 'A', generating: false, eventId: 11 }
    })

    const last = observed.at(-1)
    expect(last.byKey['codex|B']?.generating).toBe(true)
    expect(last.byKey['codex|A']).toBeUndefined()

    sub.unsubscribe()
    stop()
    stopGlobalGeneratingAggregator()
  })

  it('clears pending state when aborted without turn.complete', async () => {
    const stop = initGlobalGeneratingAggregator()
    const observed: any[] = []
    const sub = generatingState$().subscribe((s) => observed.push(s))

    hoisted.src$$.next({
      method: 'chat.info.runtime.generating',
      params: { provider: 'codex', conversationId: 'C', generating: true, eventId: 20 }
    })

    hoisted.src$$.next({
      method: 'chat.message.aborted',
      params: { provider: 'codex', conversationId: 'C', eventId: 21 }
    })

    const last = observed.at(-1)
    expect(last.byKey['codex|C']).toBeUndefined()

    sub.unsubscribe()
    stop()
    stopGlobalGeneratingAggregator()
  })
})
