import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：Explore 步骤（read/list/search）', () => {
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

  it('sed/ls/rg 被解析为 Read/List/Search 步骤并可见标题', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-explore')
    const cmd = "sed -n '1,10p' src/a.txt && ls src && rg -n foo src"
    __emit('chat.tool.exec.begin', { conversationId: 'conv-explore', callId: 'c1', command: ['bash', '-lc', cmd], cwd: '/repo' })
    __emit('chat.message.completed', { conversationId: 'conv-explore', text: 'done' })
    __emit('chat.turn.complete', { conversationId: 'conv-explore' })

    const st = useChatTurnStore.getState()
    const t = st.turns[st.turns.length - 1]
    render(<TurnAssistantView turn={t} />)
    fireEvent.click(screen.getByText(/Finished working/))
    // Read a.txt（行号）
    expect(screen.getByText(/Read a\.txt \(lines: 1-10\)/)).toBeTruthy()
    // List ls src
    expect(screen.getByText(/List ls src/)).toBeTruthy()
    // Search foo in src
    expect(screen.getByText(/Search foo in src/)).toBeTruthy()
  })
})

