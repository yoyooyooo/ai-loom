import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createProcessChatEvent } from '@/features/codex-chat/services/processors'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：patch 截断策略（max files / max chars）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })
  afterEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('只展示首个文件的 diff，并在超长时显示截断标记', async () => {
    chatTurnActions.setConversationId('conv-patch')
    const processor = createProcessChatEvent({
      useRxDelta: false,
      aggregateTools: true,
      keepToolStream: false,
      patchMaxFiles: 1,
      patchMaxChars: 120
    })
    const long = 'line1\n' + 'x'.repeat(300)
    processor('chat.tool.patch.begin', {
      conversationId: 'conv-patch',
      callId: 'p1',
      files: 2,
      firstPath: 'a.txt',
      adds: 10,
      dels: 0,
      changes: {
        'a.txt': { update: { unified_diff: long } },
        'b.txt': { update: { unified_diff: '--- c\n+++ d\n@@\n- q\n+ w' } }
      }
    })
    processor('chat.tool.patch.end', { conversationId: 'conv-patch', callId: 'p1', success: true })
    processor('chat.message.completed', { conversationId: 'conv-patch', text: 'done' })
    processor('chat.turn.complete', { conversationId: 'conv-patch' })

    const st = useChatTurnStore.getState()
    const t = chatTurnSelectors.sliceById('conv-patch')(st).turns.at(-1)!
    render(<TurnAssistantView turn={t} />)
    // 展开 Working 折叠区与 patch 步骤
    fireEvent.click(screen.getByText(/Finished working/))
    fireEvent.click(screen.getByText(/patch a\.txt/))

    // 只应看到 a.txt 的 diff，不应出现 b.txt 的标题
    expect(screen.getByText(/### a\.txt/)).toBeTruthy()
    expect(screen.queryByText(/### b\.txt/)).toBeNull()
    // 超长应被截断
    expect(screen.getByText(/\(diff truncated\)/)).toBeTruthy()
  })
})
