import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { TurnAssistantView } from '../components/turn-item'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'

describe('UI：Working 头部计数显示', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('仅 streaming 且无步骤/无推理 → 显示 Working，不带（0 条）', () => {
    // 构造一个进行中的 turn（仅用户文本，无任何步骤/推理）
    chatTurnActions.addUserTurn('hi')
    const st = useChatTurnStore.getState()
    const t = st.turns[0]
    // 仅渲染 Assistant 视图
    render(<TurnAssistantView turn={t} />)
    // Working 头部存在
    const trigger = screen.getByText('Working')
    expect(trigger).toBeTruthy()
    // 不应显示“（0 条）”
    expect(screen.queryByText(/（0 条）/)).toBeNull()
  })
})

