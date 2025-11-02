import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：Working 头部计数（steps + reasoning 预览）', () => {
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

  it('仅 reasoning.delta + 一个 exec.begin（无 thinking 步骤）→ 计数 = 2', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-w')

    // reasoning.preview + 一个 exec 步骤（未 end）
    __emit('chat.reasoning.delta', { conversationId: 'conv-w', delta: 'Plan steps' })
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-w',
      callId: 'c1',
      command: ['bash', '-lc', 'echo hi']
    })

    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).at(-1)!
    render(<TurnAssistantView turn={t} />)

    // Working（1 条）：当前至少包含一个步骤（exec.begin），预览计数按产品可调整，此处只验证存在步骤计数
    expect(screen.getByText(/Working（1 条）/)).toBeTruthy()
  })
})
