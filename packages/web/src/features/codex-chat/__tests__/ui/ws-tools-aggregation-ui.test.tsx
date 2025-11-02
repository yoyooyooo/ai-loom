import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { TurnAssistantView } from '@/features/codex-chat/components/turn-item'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('UI：工具步骤聚合与渲染（exec/mcp/patch）', () => {
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

  it('exec/mcp/patch 的封面标题与标签、diff 内容正确渲染', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ui')

    // exec
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-ui',
      callId: 'c1',
      command: ['bash', '-lc', 'echo hi'],
      cwd: '/tmp'
    })
    __emit('chat.tool.exec.output', {
      conversationId: 'conv-ui',
      callId: 'c1',
      text: 'hi\n',
      stream: 'stdout'
    })
    __emit('chat.tool.exec.end', {
      conversationId: 'conv-ui',
      callId: 'c1',
      exitCode: 0,
      stdout: 'hi\n'
    })

    // mcp
    __emit('chat.tool.mcp.begin', {
      conversationId: 'conv-ui',
      callId: 'm1',
      server: 's',
      tool: 't',
      arguments: { q: 'x' }
    })
    __emit('chat.tool.mcp.end', {
      conversationId: 'conv-ui',
      callId: 'm1',
      server: 's',
      tool: 't',
      result: { ok: true }
    })

    // patch（单文件 diff）
    __emit('chat.tool.patch.begin', {
      conversationId: 'conv-ui',
      callId: 'p1',
      files: 1,
      firstPath: 'a.txt',
      adds: 2,
      dels: 1,
      changes: {
        'a.txt': { update: { unified_diff: '--- a\n+++ b\n@@\n- old\n+ new' } }
      }
    })
    __emit('chat.tool.patch.end', { conversationId: 'conv-ui', callId: 'p1', success: true })

    // 回答完成
    __emit('chat.message.completed', { conversationId: 'conv-ui', text: 'done' })
    __emit('chat.turn.complete', { conversationId: 'conv-ui' })

    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState()).at(-1)!
    render(<TurnAssistantView turn={t} />)
    // 展开 Working 折叠区，显示步骤列表
    const trigger = screen.getByText(/Finished working/)
    fireEvent.click(trigger)

    // exec 展示首行命令
    expect(screen.getAllByText(/echo hi/).length).toBeGreaterThan(0)
    // mcp 展示 server/tool
    expect(screen.getByText('s/t')).toBeTruthy()
    // patch 展示 "patch a.txt" 与标签 +2 / -1
    expect(screen.getByText(/patch a\.txt/)).toBeTruthy()
    expect(screen.getByText('+2')).toBeTruthy()
    expect(screen.getByText('-1')).toBeTruthy()
    // diff 内容可见
    expect(screen.getByText(/new/)).toBeTruthy()
    // 回答渲染
    expect(screen.getByText('done')).toBeTruthy()
  })
})
