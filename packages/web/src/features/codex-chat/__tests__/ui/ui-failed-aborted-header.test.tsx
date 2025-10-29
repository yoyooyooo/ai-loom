import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：Failed/Aborted 头部状态', () => {
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

  it('Failed：显示 Failed，且不为 Working', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-fail')
    __emit('chat.message.delta', { conversationId: 'conv-fail', delta: '...' })
    __emit('chat.message.failed', { conversationId: 'conv-fail', error: { message: 'boom' } })
    __emit('chat.turn.complete', { conversationId: 'conv-fail' })
    const st = useChatTurnStore.getState()
    const t = st.turns[st.turns.length - 1]
    render(<TurnAssistantView turn={t} />)
    // 按当前规范：无步骤/无推理时不显示 Working 头部；直接渲染错误信息
    expect(screen.queryByText('Failed')).toBeNull()
    expect(screen.getByText('boom')).toBeTruthy()
  })

  it('Aborted：显示 Aborted', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-abort')
    __emit('chat.message.delta', { conversationId: 'conv-abort', delta: '...' })
    __emit('chat.message.aborted', { conversationId: 'conv-abort' })
    __emit('chat.turn.complete', { conversationId: 'conv-abort' })
    const st = useChatTurnStore.getState()
    const t = st.turns[st.turns.length - 1]
    render(<TurnAssistantView turn={t} />)
    // 不显示头部；渲染已收集文本
    expect(screen.queryByText('Aborted')).toBeNull()
    expect(screen.getByText('...')).toBeTruthy()
  })
})
