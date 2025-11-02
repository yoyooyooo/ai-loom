import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { vi } from 'vitest'
vi.mock('@/lib/ws/singleton')
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('WS 实时：turn 完成后的后续事件与 Working 头部', () => {
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
  })

  it('在上一轮已结束后收到 tool.begin → 应开启新 turn（不应写入已完成的上一轮）', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-n1')
    __emit('chat.turn.started', { conversationId: 'conv-n1' })
    __emit('chat.message.completed', { conversationId: 'conv-n1', text: 'done' })
    // 上一轮已结束
    expect(chatTurnSelectors.currentSlice(useChatTurnStore.getState()).activeTurnId).toBeUndefined()
    const beforeTurns = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).length
    // 新的工具开始事件应隐式开启新一轮
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-n1',
      callId: 'c-next',
      command: ['bash', '-lc', 'echo hi']
    })
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBeGreaterThan(beforeTurns)
    const last = slice.turns[slice.turns.length - 1]
    expect(last.status).toBe('streaming')
    expect(Array.isArray(last.steps) && last.steps.length > 0).toBe(true)
  })
})
