import React from 'react'
import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

describe('UI：Resume-only 推理（无步骤）应显示为独立 thinking 折叠区', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('history 仅 reasoning 时，不显示 Working，显示 thinking 折叠', async () => {
    chatTurnActions.loadSnapshot([{ role: 'reasoning', text: 'Plan\n\nA\nB' } ] as any, [])
    const st = useChatTurnStore.getState()
    const t = st.turns[0]
    render(<TurnAssistantView turn={t} />)
    // 不显示 Working 头部
    expect(screen.queryByText(/^Working/)).toBeNull()
    // 显示 thinking 折叠（标签）
    expect(screen.getByText('thinking')).toBeTruthy()
    expect(screen.getByText(/Plan/)).toBeTruthy()
  })
})

