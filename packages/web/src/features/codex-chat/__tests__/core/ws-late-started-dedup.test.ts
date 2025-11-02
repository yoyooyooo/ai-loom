import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('WS：晚到 started 与 completed 去重', () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })
  afterEach(() => {
    if (stop) stop()
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('先 completed 后晚到 started（时间早于已完成）→ 不应新增 turn', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-late')

    __emit('chat.message.completed', {
      conversationId: 'conv-late',
      text: 'hello',
      ts: '2025-01-01T00:00:10.000Z'
    })
    let slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(1)
    const t0 = slice.turns[0]
    expect(t0.assistant.text).toBe('hello')
    expect(slice.activeTurnId).toBeUndefined()

    // 晚到的 started（时间早于上一轮完成/消息时间）应被忽略
    __emit('chat.turn.started', {
      conversationId: 'conv-late',
      startedAt: '2025-01-01T00:00:05.000Z'
    })

    slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(1)
    expect(slice.turns[0].assistant.text).toBe('hello')
  })

  it('无活动轮且上一轮 assistant 文本相同的重复 completed → 忽略', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-dedup')

    __emit('chat.message.completed', { conversationId: 'conv-dedup', text: 'same' })
    let slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(1)
    expect(slice.activeTurnId).toBeUndefined()

    // 再次收到相同文本的 completed（无 started/streaming）
    __emit('chat.message.completed', { conversationId: 'conv-dedup', text: 'same' })

    slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    // 不应新增 turn
    expect(slice.turns.length).toBe(1)
    expect(slice.turns[0].assistant.text).toBe('same')
  })
})
