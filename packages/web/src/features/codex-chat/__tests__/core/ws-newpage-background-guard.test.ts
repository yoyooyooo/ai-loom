import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('/chat 新建页：背景会话事件不应抢占会话', () => {
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

  it('未选择会话时，普通 chat.* 事件不应更改 conversationId；仅 chat.session.* 允许设置', () => {
    stop = subscribeChatEvents()

    // 初始：无会话
    expect(useChatTurnStore.getState().conversationId).toBeUndefined()

    // 来自背景会话的普通事件（不应切换/设置会话）
    __emit('chat.message.delta', { conversationId: 'bg', delta: 'x' })
    __emit('chat.message.completed', { conversationId: 'bg', text: 'hello' })
    __emit('chat.turn.complete', { conversationId: 'bg' })

    const afterBg = useChatTurnStore.getState()
    expect(afterBg.conversationId).toBeUndefined()

    // chat.session.new 才允许设置会话
    __emit('chat.session.new', { conversationId: 'bg' })
    const afterNew = useChatTurnStore.getState()
    expect(afterNew.conversationId).toBe('bg')
  })
})
