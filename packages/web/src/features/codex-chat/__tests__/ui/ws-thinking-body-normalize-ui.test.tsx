import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：thinking 内容去重（首行等于标题时剔除）', () => {
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

  it('thinking: Plan 的正文不应包含重复的首行标题', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-think-ui')
    const text = 'Plan\n\nLine A\nLine B'
    __emit('chat.reasoning.end', { conversationId: 'conv-think-ui', text })
    __emit('chat.tool.exec.begin', { conversationId: 'conv-think-ui', callId: 'c1', command: ['bash', '-lc', 'echo ok'] })
    __emit('chat.message.completed', { conversationId: 'conv-think-ui', text: 'ok' })
    __emit('chat.turn.complete', { conversationId: 'conv-think-ui' })

    const st = useChatTurnStore.getState()
    const t = st.turns[st.turns.length - 1]
    render(<TurnAssistantView turn={t} />)
    fireEvent.click(screen.getByText(/Finished working/))
    expect(screen.getByText('thinking: Plan')).toBeTruthy()
    const body = screen.getByText(/Line A/)
    expect(body).toBeTruthy()
    expect(screen.queryByText(/^Plan$/)).toBeNull()
  })
})

