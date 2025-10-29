import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Subject } from 'rxjs'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')

// Helpers exposed by the mock above
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mock helper only exists in tests
import { __emit, __getFilters, __resetWsMock, ws as mockWs } from '@/lib/ws/singleton'

describe('subscribeChatEvents', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  afterEach(() => {
    if (stop) {
      stop()
      stop = undefined
    }
    chatTurnActions.reset()
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('updates conversation id on session events', () => {
    stop = subscribeChatEvents()
    __emit('chat.session.new', { conversationId: 'abc' })
    expect(useChatTurnStore.getState().conversationId).toBe('abc')
  })

  it('ignores deltas from other conversations and accepts matching ones', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-1')

    __emit('chat.message.delta', { conversationId: 'other', delta: 'skip' })
    expect(useChatTurnStore.getState().turns).toHaveLength(0)

    __emit('chat.message.delta', { conversationId: 'conv-1', delta: 'take' })
    const turns = useChatTurnStore.getState().turns
    expect(turns).toHaveLength(1)
    expect(turns[0]?.assistant.text).toContain('take')
  })

  it('zustand subscribe fires when conversation id changes (sanity check)', async () => {
    const events: Array<string | undefined> = []
    const unsubscribe = useChatTurnStore.subscribe((state, prev) => {
      if (state.conversationId === prev?.conversationId) return
      events.push(state.conversationId)
    })
    chatTurnActions.setConversationId('alpha')
    await new Promise((resolve) => setTimeout(resolve, 0))
    chatTurnActions.setConversationId('beta')
    await new Promise((resolve) => setTimeout(resolve, 0))
    unsubscribe()
    expect(events).toEqual(['alpha', 'beta'])
  })

  it('subscribes to chat topic with current conversation id and refreshes on change', async () => {
    stop = subscribeChatEvents()
    expect(__getFilters().at(-1)).toEqual({ topic: 'chat', filter: {} })
    expect(__getFilters().length).toBe(1)

    chatTurnActions.setConversationId('first')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(__getFilters().length).toBeGreaterThanOrEqual(2)
    const filtersAfterFirst = __getFilters()
    expect(filtersAfterFirst.length).toBeGreaterThanOrEqual(2)
    expect(filtersAfterFirst.at(-1)).toEqual({ topic: 'chat', filter: { conversationId: 'first' } })

    chatTurnActions.setConversationId('second')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(__getFilters().length).toBeGreaterThanOrEqual(3)
    const filtersAfterSecond = __getFilters()
    expect(filtersAfterSecond.length).toBeGreaterThanOrEqual(3)
    expect(filtersAfterSecond.at(-1)).toEqual({ topic: 'chat', filter: { conversationId: 'second' } })
  })

  it('processes codex runtime events and keeps single user message', () => {
    stop = subscribeChatEvents()
    // 用户发送
    chatTurnActions.addUserTurn('你好')
    chatTurnActions.setConversationId('conv-1')

    // session configured 带历史（含同一条用户消息）
    __emit('codex/sessionConfigured', {
      provider: 'codex',
      conversationId: 'conv-1',
      sessionId: 'conv-1',
      initialMessages: [
        {
          type: 'user_message',
          message: '你好'
        }
      ]
    })

    // 开始推理 + 回答
    __emit('chat.reasoning.section_break', { conversationId: 'conv-1' })
    __emit('chat.reasoning.delta', { conversationId: 'conv-1', delta: '**Preparing**' })
    __emit('chat.message.delta', { conversationId: 'conv-1', delta: '答复中' })
    __emit('chat.message.completed', { conversationId: 'conv-1', text: '完成' })
    __emit('chat.turn.complete', { conversationId: 'conv-1' })

    const state = useChatTurnStore.getState()
    expect(state.generating).toBe(false)
    expect(state.turns).toHaveLength(1)
    const [turn] = state.turns
    expect(turn?.user.text).toBe('你好')
    expect(turn?.assistant.text).toContain('完成')
    expect(turn?.reasoning?.content).toContain('Preparing')
  })
})
