import React from 'react'
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

describe('UI：Resume-only 推理（无步骤）应显示为独立 thinking 折叠区', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('server turns：reasoning-only，在 Working 折叠中展示 thinking 步骤', async () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: '', ts: '' },
        assistant: { text: '' },
        steps: [
          {
            id: 'th1',
            kind: 'thinking',
            title: 'thinking: Plan',
            status: 'completed',
            ts: '',
            body: 'Plan\n\nA\nB'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const st = useChatTurnStore.getState()
    const t = chatTurnSelectors.currentSlice(st).turns[0]
    render(<TurnAssistantView turn={t} />)
    // Working 折叠默认收起，点击展开查看步骤
    const trigger = screen.getByRole('button', { name: /Finished working/ })
    fireEvent.click(trigger)
    const summary = await screen.findByText(/^thinking:/i)
    expect(summary).toBeTruthy()
    expect(summary.textContent).toMatch(/Plan/i)
  })
})
