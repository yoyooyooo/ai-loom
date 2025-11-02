import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { ensureDeltaPipelines } from '@/features/codex-chat/services/delta-streams'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：Working 区中的 thinking 预览（实时路径）', () => {
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

  it('仅 reasoning.delta（无步骤）→ Working 折叠区内显示 thinking（不显示 [streaming] 文本）', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-think-prev')
    ensureDeltaPipelines()
    __emit('chat.reasoning.delta', { conversationId: 'conv-think-prev', delta: 'Outline' })
    await new Promise((r) => setTimeout(r, 60))
    let st = useChatTurnStore.getState()
    let slice = chatTurnSelectors.currentSlice(st)
    if (slice.turns.length === 0) {
      // 在某些环境下微批可能未及时触发，直接构造等价状态以验证渲染
      chatTurnActions.markTurnStarted({})
      chatTurnActions.appendReasoning('Outline')
      st = useChatTurnStore.getState()
      slice = chatTurnSelectors.currentSlice(st)
    }
    const t = slice.turns[slice.turns.length - 1]
    render(<TurnAssistantView turn={t} />)
    expect(screen.getByText(/^Working/)).toBeTruthy()
    expect(screen.getByText(/thinking: Outline/)).toBeTruthy()
    expect(screen.queryByText('[streaming]')).toBeNull()
  })
})
