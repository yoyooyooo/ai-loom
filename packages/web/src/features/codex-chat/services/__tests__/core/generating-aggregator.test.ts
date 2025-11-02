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
  const src: any = new Subject()
  return { src }
})
vi.mock('@/lib/ws/singleton', () => ({
  ws: {
    events$: (hoisted.src as any).asObservable() as Observable<{ method: string; params: any }>
  }
}))

describe('generating-aggregator', () => {
  it('on/off 状态按事件推进，compact 完成不关灯', async () => {
    const stop = initGlobalGeneratingAggregator()
    const seen: any[] = []
    const sub = generatingState$().subscribe((s) => seen.push(s))

    // A: delta 点火
    hoisted.src.next({ method: 'chat.message.delta', params: { conversationId: 'A', eventId: 1 } })
    // A: completed（非 compact）→ 仍保持点亮，等待 turn.complete 关灯
    hoisted.src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 2, text: 'done' } })
    // B: compact 完成 → 不点火
    hoisted.src.next({ method: 'chat.message.delta', params: { conversationId: 'B', eventId: 3 } })
    hoisted.src.next({ method: 'chat.message.completed', params: { conversationId: 'B', eventId: 4, text: 'Compact task completed' } })
    // A/B turn.complete → 关灯
    hoisted.src.next({ method: 'chat.turn.complete', params: { conversationId: 'A', eventId: 6 } })
    hoisted.src.next({ method: 'chat.turn.complete', params: { conversationId: 'B', eventId: 5 } })

    const last = seen.at(-1)
    expect(last.byKey['A'].generating).toBe(false)
    expect(last.byKey['B']).toBeDefined()
    expect(last.byKey['B'].generating).toBe(false)
    sub.unsubscribe()
    stop()
    stopGlobalGeneratingAggregator()
  })
})
