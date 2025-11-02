import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：exec apply_patch 被识别为 patch 步骤', () => {
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

  it('bash -lc "*** Begin Patch ..." → 渲染 patch 标题与 +-/ 标签', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-apply')
    const patch = `*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch`
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-apply',
      callId: 'c1',
      command: ['bash', '-lc', patch]
    })
    __emit('chat.message.completed', { conversationId: 'conv-apply', text: 'ok' })
    __emit('chat.turn.complete', { conversationId: 'conv-apply' })

    const st = useChatTurnStore.getState()
    const t = chatTurnSelectors.sliceById('conv-apply')(st).turns.at(-1)!
    render(<TurnAssistantView turn={t} />)
    fireEvent.click(screen.getByText(/Finished working/))
    expect(screen.getByText(/patch a\.txt/)).toBeTruthy()
    // 展示分离的 +adds 与 -dels 标签
    expect(screen.getByText('+1')).toBeTruthy()
    expect(screen.getByText('-0')).toBeTruthy()
  })
})
