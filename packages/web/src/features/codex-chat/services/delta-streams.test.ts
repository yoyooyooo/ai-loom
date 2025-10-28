import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { ensureDeltaPipelines } from './delta-streams'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'
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
    __emit('codex/event/agent_message_delta', { conversationId: 'conv-rx', msg: { type: 'agent_message_delta', delta: 'Hello' } })
    await new Promise((r) => setTimeout(r, 40))
    const st = useChatTurnStore.getState()
    expect(st.turns.length).toBe(1)
    const t = st.turns[0]
    expect(st.activeTurnId).toBe(t.id)
    expect(t.assistant.text).toContain('Hello')
  })

  it('agent_reasoning_delta 首次抵达时自动 beginTurn 并追加 reasoning', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx2')
    __emit('codex/event/agent_reasoning_delta', { conversationId: 'conv-rx2', msg: { type: 'agent_reasoning_delta', delta: 'Thinking' } })
    await new Promise((r) => setTimeout(r, 40))
    const st = useChatTurnStore.getState()
    expect(st.turns.length).toBe(1)
    const t = st.turns[0]
    expect(st.activeTurnId).toBe(t.id)
    expect(t.reasoning?.content || '').toContain('Thinking')
  })
})
