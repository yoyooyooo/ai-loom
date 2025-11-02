import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：thinking 步骤去重（WS 路径）', () => {
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

  it('相同文本的 chat.reasoning.end 仅渲染一个 thinking 步骤', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-think')
    const text = 'Plan\n\n1. a\n2. b'
    __emit('chat.reasoning.end', { conversationId: 'conv-think', text })
    __emit('chat.reasoning.end', { conversationId: 'conv-think', text })
    // 加一个 exec 步骤，确保 thinking 在 steps 列表中（非预览）
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-think',
      callId: 'c1',
      command: ['bash', '-lc', 'echo ok']
    })
    __emit('chat.message.completed', { conversationId: 'conv-think', text: 'ok' })
    __emit('chat.turn.complete', { conversationId: 'conv-think' })

    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).at(-1)!
    render(<TurnAssistantView turn={t} />)
    fireEvent.click(screen.getByText(/Finished working/))
    // thinking: Plan 只出现一次
    const nodes = screen.getAllByText(/thinking: Plan/)
    expect(nodes.length).toBe(1)
  })
})
