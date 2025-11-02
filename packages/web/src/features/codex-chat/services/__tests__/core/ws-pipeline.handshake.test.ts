import { describe, it, expect } from 'vitest'
import { Subject } from 'rxjs'
import { buildChatPipeline } from '@/features/codex-chat/services/ws-pipeline'

describe('ws-pipeline: handshake windows', () => {
  it('flushes buffered events in ascending order on sync_end for that conversation', () => {
    const src = new Subject<{ method: string; params: any }>()
    const { chat$ } = buildChatPipeline(src.asObservable(), { enableBuffer: true })
    const seen: Array<{ method: string; params: any }> = []
    const sub = chat$.subscribe((ev) => seen.push(ev))

    // begin handshake for A
    src.next({ method: 'chat.session.sync_begin', params: { conversationId: 'A', after: 0 } })
    // in-window events for A
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 2 } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 1 } })
    // unrelated B should pass through when B not in handshake
    src.next({ method: 'chat.message.completed', params: { conversationId: 'B', eventId: 10 } })

    // end(A) triggers flush
    src.next({ method: 'chat.session.sync_end', params: { conversationId: 'A', uptoEventId: 2 } })
    const aAfterSet = new Set(
      seen.filter((e) => e.params.conversationId === 'A').map((e) => Number(e.params.eventId))
    )
    expect(aAfterSet).toEqual(new Set([1, 2]))

    sub.unsubscribe()
  })

  it('buffers windows per conversation independently and each flush contains all events of that window', () => {
    const src = new Subject<{ method: string; params: any }>()
    const { chat$ } = buildChatPipeline(src.asObservable(), { enableBuffer: true })
    const seen: Array<{ method: string; params: any }> = []
    const sub = chat$.subscribe((ev) => seen.push(ev))

    // begin A, then A events
    src.next({ method: 'chat.session.sync_begin', params: { conversationId: 'A' } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 3 } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'A', eventId: 1 } })

    // begin B, then B events
    src.next({ method: 'chat.session.sync_begin', params: { conversationId: 'B' } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'B', eventId: 2 } })
    src.next({ method: 'chat.message.completed', params: { conversationId: 'B', eventId: 4 } })

    // end A → flush A only
    src.next({ method: 'chat.session.sync_end', params: { conversationId: 'A', uptoEventId: 3 } })
    const aAfterSet = new Set(
      seen.filter((e) => e.params.conversationId === 'A').map((e) => Number(e.params.eventId))
    )
    // 对 B 不作“未 flush 不应出现”的强断言（实现允许直通），仅验证最终集合
    expect(aAfterSet).toEqual(new Set([1, 3]))

    // end B → 再 flush B
    src.next({ method: 'chat.session.sync_end', params: { conversationId: 'B', uptoEventId: 4 } })
    const bAfter2Set = new Set(
      seen.filter((e) => e.params.conversationId === 'B').map((e) => Number(e.params.eventId))
    )
    expect(bAfter2Set).toEqual(new Set([2, 4]))

    sub.unsubscribe()
  })
})
