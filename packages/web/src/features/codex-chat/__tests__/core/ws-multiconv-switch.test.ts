import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock, __getFilters } from '@/lib/ws/singleton'

describe('WS 多会话快速切换串扰防护（按会话过滤 + 守卫）', () => {
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

  it('切换 A→B：A 的迟到帧不应污染 B，会话订阅立即切换', async () => {
    stop = subscribeChatEvents()

    // 初始订阅为 chat + {}
    expect(__getFilters().at(0)).toEqual({ topic: 'chat', filter: {} })

    // 切换到 A
    chatTurnActions.setConversationId('A')
    await new Promise((r) => setTimeout(r, 0))
    expect(__getFilters().at(-1)).toEqual({ topic: 'chat', filter: { conversationId: 'A' } })

    // A 与 B 同时来帧，应只接受 A
    __emit('chat.message.delta', { conversationId: 'B', delta: 'b1' })
    __emit('chat.message.delta', { conversationId: 'A', delta: 'a1' })
    __emit('chat.message.completed', { conversationId: 'A', text: 'A-OK' })
    __emit('chat.turn.complete', { conversationId: 'A' })

    let st = useChatTurnStore.getState()
    expect(st.turns.length).toBeGreaterThan(0)
    const lastA = st.turns[st.turns.length - 1]
    expect(lastA.assistant.text).toBe('A-OK')

    // 立即切换到 B
    chatTurnActions.setConversationId('B')
    await new Promise((r) => setTimeout(r, 0))
    expect(__getFilters().at(-1)).toEqual({ topic: 'chat', filter: { conversationId: 'B' } })

    const turnsBeforeLateA = st.turns.length
    // A 的迟到帧（完成后才到的 delta）
    __emit('chat.message.delta', { conversationId: 'A', delta: 'A-late' })
    // B 的新帧
    __emit('chat.message.delta', { conversationId: 'B', delta: 'b2' })
    __emit('chat.message.completed', { conversationId: 'B', text: 'B-OK' })
    __emit('chat.turn.complete', { conversationId: 'B' })

    st = useChatTurnStore.getState()
    // A 迟到帧不应改变 turns 数与最后一轮内容（不污染）
    expect(st.turns.length).toBeGreaterThanOrEqual(turnsBeforeLateA)
    const last = st.turns[st.turns.length - 1]
    expect(last.assistant.text).toBe('B-OK')
  })
})

