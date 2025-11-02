import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'

describe('UI：Working 头部计数显示', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('仅 streaming 且无步骤/无推理 → 不展示 Working 头部（仅显示三点占位）', () => {
    // 构造一个进行中的 turn（仅用户文本，无任何步骤/推理）
    chatTurnActions.addUserTurn('hi')
    const st = useChatTurnStore.getState()
    const t = chatTurnSelectors.currentSlice(st).turns[0]
    // 仅渲染 Assistant 视图
    render(<TurnAssistantView turn={t} />)
    // 不展示 Working 头部（无可展开内容）
    expect(screen.queryByText('Working')).toBeNull()
    // 也不显示“（0 条）”
    expect(screen.queryByText(/（0 条）/)).toBeNull()
  })
})
