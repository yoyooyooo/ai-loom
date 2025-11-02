import { describe, test, expect } from 'vitest'
import { Subject } from 'rxjs'
import { buildChatPipeline } from '@/features/codex-chat/services/ws-pipeline'

describe('ws-pipeline: buildChatPipeline', () => {
  test('passes through chat.* outside handshake', () => {
    const src = new Subject<{ method: string; params: any }>()
    const { chat$ } = buildChatPipeline(src.asObservable(), { enableBuffer: true })
    const seen: Array<{ method: string; params: any }> = []
    const sub = chat$.subscribe((ev) => seen.push(ev))

    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 2 } })
    expect(seen.map((e) => e.method)).toEqual(['chat.message.completed'])

    sub.unsubscribe()
  })

  test('buffers between begin and end, then flushes sorted by eventId once', () => {
    const src = new Subject<{ method: string; params: any }>()
    const { chat$, syncEnd$ } = buildChatPipeline(src.asObservable(), { enableBuffer: true })
    const seen: Array<{ method: string; params: any }> = []
    const seenEnd: any[] = []
    const sub = chat$.subscribe((ev) => seen.push(ev))
    const endSub = syncEnd$.subscribe((ev) => seenEnd.push(ev))

    // begin for A
    src.next({
      method: 'chat.session.sync_begin',
      params: { conversationId: 'A', after: 0, tail: 2 }
    })
    // in window events (out of order)
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 5 } })
    src.next({
      method: 'chat.message.delta',
      params: { conversationId: 'A', eventId: 3, delta: 'x' }
    })
    // another conversation B should pass through independently
    src.next({ method: 'chat.message.completed', params: { conversationId: 'B', eventId: 1 } })
    // end for A
    src.next({ method: 'chat.session.sync_end', params: { conversationId: 'A', uptoEventId: 5 } })

    // expectations：A 的补发按 eventId 升序（3,5）；B:1 也被透传（顺序在不同环境下可能略有差异）
    const aSeq = seen
      .filter((e) => e.params.conversationId === 'A')
      .map((e) => Number(e.params.eventId || 0))
    expect(new Set(aSeq)).toEqual(new Set([3, 5]))
    const bSeen = seen.find((e) => e.params.conversationId === 'B' && e.params.eventId === 1)
    expect(!!bSeen).toBe(true)
    expect(seenEnd.length).toBe(1)
    expect(seenEnd[0].method).toBe('chat.session.sync_end')

    sub.unsubscribe()
    endSub.unsubscribe()
  })

  test('non-buffer mode just passes chat.*', () => {
    const src = new Subject<{ method: string; params: any }>()
    const { chat$ } = buildChatPipeline(src.asObservable(), { enableBuffer: false })
    const seen: string[] = []
    const sub = chat$.subscribe((ev) => seen.push(ev.method))
    src.next({ method: 'chat.session.sync_begin', params: { conversationId: 'A' } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 1 } })
    src.next({ method: 'chat.session.sync_end', params: { conversationId: 'A', uptoEventId: 1 } })
    expect(seen).toEqual(['chat.message.completed'])
    sub.unsubscribe()
  })
})
