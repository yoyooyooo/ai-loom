import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { ensureDeltaPipelines } from '@/features/codex-chat/services/delta-streams'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

vi.mock('@/lib/ws/singleton')

describe('delta-streams 隐式开启（Rx 批处理场景）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })
  afterEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('agent_message_delta 首次抵达时自动 beginTurn 并追加 delta', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx')
    __emit('chat.message.delta', { conversationId: 'conv-rx', delta: 'Hello' })
    await waitFor(() => expect(useChatTurnStore.getState().turns.length).toBe(1), {
      timeout: 800
    })
    const st = useChatTurnStore.getState()
    const t = st.turns[0]
    expect(st.activeTurnId).toBe(t.id)
    expect(t.assistant.text).toContain('Hello')
  })

  it('agent_reasoning_delta 首次抵达时自动 beginTurn 并追加 reasoning', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx2')
    __emit('chat.reasoning.delta', { conversationId: 'conv-rx2', delta: 'Thinking' })
    await waitFor(() => expect(useChatTurnStore.getState().turns.length).toBe(1), {
      timeout: 800
    })
    const st = useChatTurnStore.getState()
    const t = st.turns[0]
    expect(st.activeTurnId).toBe(t.id)
    expect(t.reasoning?.content || '').toContain('Thinking')
  })
})
