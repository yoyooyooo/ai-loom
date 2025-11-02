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

describe('UI：最终消息开始输出即收起 Working', () => {
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

  it('chat.message.delta 到达后，Working 变为 Finished working', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-fs')

    // 开始一轮，并写入 reasoning 预览，初始应显示 Working
    __emit('chat.turn.started', { conversationId: 'conv-fs' })
    __emit('chat.reasoning.delta', { conversationId: 'conv-fs', delta: 'Plan…' })

    const st1 = useChatTurnStore.getState()
    const t = chatTurnSelectors.sliceById('conv-fs')(st1).turns.at(-1)!
    render(<TurnAssistantView turn={t} />)
    expect(screen.getByText(/Working/)).toBeTruthy()

    // 最终 Assistant 文本 delta 到达 → 立即收起 Working（标题变为 Finished working）
    __emit('chat.message.delta', { conversationId: 'conv-fs', delta: 'Hello' })
    expect(await screen.findByText(/Finished working/)).toBeTruthy()
  })
})
