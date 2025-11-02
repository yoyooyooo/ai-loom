import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore only exists in tests
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：Plan 更新保持 Working 展开', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-plan')
    chatTurnActions.addUserTurn('你好')
  })

  afterEach(() => {
    stop?.()
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('plan 未完成时，Working 保持展开且标题为 Working', () => {
    __emit('chat.info.plan_update', {
      conversationId: 'conv-plan',
      plan: [
        { step: '分析需求', status: 'in_progress' },
        { step: '生成代码', status: 'pending' }
      ],
      explanation: '初始计划'
    })

    __emit('chat.message.delta', { conversationId: 'conv-plan', delta: '处理中…' })

    const turnSlice = chatTurnSelectors.sliceById('conv-plan')(useChatTurnStore.getState())
    const turn = turnSlice.turns.at(-1)
    expect(turn).toBeTruthy()
    expect(turn?.steps.at(-1)?.status).toBe('streaming')

    render(<TurnAssistantView turn={turn!} />)
    const trigger = screen.getByRole('button', { name: /Working/ })
    expect(trigger.textContent).toContain('Working')
    expect(trigger.getAttribute('data-state')).toBe('open')
    expect(screen.queryByText(/Finished working/)).toBeNull()
  })
})
