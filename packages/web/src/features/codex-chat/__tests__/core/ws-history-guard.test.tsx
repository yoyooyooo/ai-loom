import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('WS：chat.session.history 幂等守卫（不覆盖已有 turns）', () => {
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

  it('已有 turns 时，history 不应覆盖；无 turns 时也不再使用 history', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-h')

    // 先形成一轮完成的对话
    __emit('chat.message.delta', { conversationId: 'conv-h', delta: 'hi' })
    __emit('chat.message.completed', { conversationId: 'conv-h', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-h' })
    const before = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).length
    const last = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[before - 1]
    expect(last.assistant.text).toBe('OK')

    // 迟到的 history（不应覆盖）
    __emit('chat.session.history', {
      conversationId: 'conv-h',
      messages: [
        { role: 'user', text: 'u1' },
        { role: 'assistant', text: 'a1' }
      ]
    })
    const after = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).length
    const last2 = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[after - 1]
    expect(after).toBe(before)
    expect(last2.assistant.text).toBe('OK')

    // 无 turns 时：history 已被忽略（由 HTTP resume 的 turns 提供首屏）
    chatTurnActions.reset()
    chatTurnActions.setConversationId('conv-h2')
    __emit('chat.session.history', {
      conversationId: 'conv-h2',
      messages: [
        { role: 'user', text: 'u2' },
        { role: 'assistant', text: 'a2' }
      ]
    })
    const slice3 = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice3.turns.length).toBe(0)
  })
})
