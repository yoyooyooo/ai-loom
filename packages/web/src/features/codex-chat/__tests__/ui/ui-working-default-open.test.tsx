import React from 'react'
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'

describe('UI：Working 默认展开逻辑', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('仅最后一个 Working turn 默认展开', () => {
    chatTurnActions.setConversationId('conv-working')
    chatTurnActions.addUserTurn('first turn')
    chatTurnActions.addStep('exec', 'call-first', 'first exec')
    chatTurnActions.addUserTurn('second turn')
    chatTurnActions.addStep('exec', 'call-second', 'second exec')

    const turns = chatTurnSelectors.currentTurns(useChatTurnStore.getState())
    expect(turns).toHaveLength(2)

    const first = turns[0]
    const second = turns[1]

    render(
      <>
        <TurnAssistantView turn={first} />
        <TurnAssistantView turn={second} />
      </>
    )

    const triggers = screen.getAllByRole('button', { name: /Working/ })
    expect(triggers).toHaveLength(2)
    expect(triggers[0].getAttribute('data-state')).toBe('closed')
    expect(triggers[1].getAttribute('data-state')).toBe('open')
  })
})
