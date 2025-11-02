import React from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

describe('UI：/chat 新建页不被背景消息覆盖', () => {
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
    vi.spyOn(chatApi, 'listConversations').mockResolvedValue({ items: [] } as any)
  })
  afterEach(() => {
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('在 /chat 无会话时，收到其他会话的 chat.* 不应替换右侧输入区', async () => {
    renderApp('/chat')

    // 初始应显示“开始新的对话”引导与输入区
    expect(await screen.findByText('开始新的对话')).toBeTruthy()

    // 背景会话的消息（不应改变 UI 状态，不应展示该会话文本）
    __emit('chat.turn.started', { conversationId: 'bg' })
    __emit('chat.message.delta', { conversationId: 'bg', delta: 'hello' })
    __emit('chat.message.completed', { conversationId: 'bg', text: 'hello world' })

    // 仍然保持新建页态（未切换会话）
    await waitFor(() => {
      expect(screen.getByText('开始新的对话')).toBeTruthy()
    })
  })
})
