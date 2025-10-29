import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

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

  it('已有 turns 时，history 不应覆盖（仅在 turns 为空时填充）', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-h')

    // 先形成一轮完成的对话
    __emit('chat.message.delta', { conversationId: 'conv-h', delta: 'hi' })
    __emit('chat.message.completed', { conversationId: 'conv-h', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-h' })
    const before = useChatTurnStore.getState().turns.length
    const last = useChatTurnStore.getState().turns[before - 1]
    expect(last.assistant.text).toBe('OK')

    // 迟到的 history（不应覆盖）
    __emit('chat.session.history', {
      conversationId: 'conv-h',
      messages: [
        { role: 'user', text: 'u1' },
        { role: 'assistant', text: 'a1' }
      ]
    })
    const after = useChatTurnStore.getState().turns.length
    const last2 = useChatTurnStore.getState().turns[after - 1]
    expect(after).toBe(before)
    expect(last2.assistant.text).toBe('OK')

    // 无 turns 时：允许 history 填充
    chatTurnActions.reset()
    chatTurnActions.setConversationId('conv-h2')
    __emit('chat.session.history', {
      conversationId: 'conv-h2',
      messages: [
        { role: 'user', text: 'u2' },
        { role: 'assistant', text: 'a2' }
      ]
    })
    const st3 = useChatTurnStore.getState()
    expect(st3.turns.length).toBe(1)
    expect(st3.turns[0]?.assistant.text).toBe('a2')
  })
})

