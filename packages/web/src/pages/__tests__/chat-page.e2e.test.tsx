import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import ChatPage from '@/pages/chat-page'
import { chatApi } from '@/features/codex-chat/services/api'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

function renderApp(path: string) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('ChatPage E2E（轻量，端到端渲染）', () => {
  beforeEach(() => {
    __resetWsMock()
    vi.spyOn(chatApi, 'getConfig').mockResolvedValue({
      models: [
        {
          id: 'm1',
          model: 'gpt-x',
          displayName: 'gpt-x',
          isDefault: true,
          supportedReasoningEfforts: []
        }
      ],
      defaults: { model: 'gpt-x', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    } as any)
  })
  afterEach(() => {
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('加载带会话路由 → resume → 接收 WS 增量 → 渲染稳定', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-e2e',
      turns: [
        {
          id: 'turn-1',
          seq: 1,
          conversationId: 'conv-e2e',
          status: 'completed',
          user: { text: 'hello', ts: '' },
          assistant: { text: 'world' },
          steps: []
        }
      ],
      inProgress: false,
      turnsSchemaVersion: 1,
      uptoEventId: 0
    } as any)
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue({ items: [] } as any)

    renderApp('/chat/conv-e2e')

    // 输入区已渲染（默认提示“输入消息...”）
    expect(await screen.findByPlaceholderText('输入消息...')).toBeTruthy()
    // 首屏 assistant 文本已渲染（来自 turns 快照）
    expect(await screen.findByText('world')).toBeTruthy()

    __emit('chat.message.delta', { conversationId: 'conv-e2e', delta: ' more' })
    __emit('chat.message.completed', { conversationId: 'conv-e2e', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-e2e' })

    await waitFor(() => {
      expect(screen.getAllByText(/OK/).length).toBeGreaterThan(0)
    })
  })
})
