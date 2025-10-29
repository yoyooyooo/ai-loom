import React, { useEffect } from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { useResumeAndPoll } from '@/features/codex-chat/services/resume-restore'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import { useChatResumeStore } from '@/features/codex-chat/stores/chat-resume'
import { chatApi } from '@/features/codex-chat/services/api'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

function Host({ conversationKey }: { conversationKey?: string }) {
  useEffect(() => {
    const off = subscribeChatEvents()
    return () => off()
  }, [])
  // 仅触发 resume 逻辑，导航可选
  useResumeAndPoll(conversationKey)
  return null
}

function renderHost(conversationKey?: string) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <Host conversationKey={conversationKey} />
    </QueryClientProvider>
  )
}

describe('集成：Resume + WS → turns（最小宿主）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
    vi.spyOn(chatApi, 'getConfig').mockResolvedValue({
      models: [],
      defaults: { model: 'm', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    } as any)
  })
  afterEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('已完成会话刷新：history（含 assistant）渲染为稳定 turns', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-c',
      history: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'world' }
      ],
      events: [],
      inProgress: false
    } as any)

    renderHost('conv-c')

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      expect(st.turns.length).toBe(1)
      expect(st.turns[0]?.assistant.text).toBe('world')
    })

    // banner 设置为“已恢复到历史会话”
    const banner = useChatResumeStore.getState().banner
    expect(banner?.kind).toBe('info')
  })

  it('未完成会话：history 仅用户 → 接续 WS 完成同一轮', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-p',
      history: [{ role: 'user', text: 'hi' }],
      events: [],
      inProgress: true
    } as any)

    renderHost('conv-p')

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      expect(st.turns.length).toBe(1)
      expect(st.turns[0]?.user.text).toBe('hi')
    })

    __emit('chat.message.delta', { conversationId: 'conv-p', delta: 'stream...' })
    __emit('chat.message.completed', { conversationId: 'conv-p', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-p' })

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      const last = st.turns[st.turns.length - 1]
      expect((last?.assistant.text || '')).toContain('OK')
    })
  })

  it('新会话：无 resume，仅 WS 首帧携带 conversationId 即可渲染', async () => {
    renderHost(undefined)
    __emit('chat.message.delta', { conversationId: 'conv-n1', delta: 'hello' })
    __emit('chat.message.completed', { conversationId: 'conv-n1', text: 'done' })
    __emit('chat.turn.complete', { conversationId: 'conv-n1' })

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      expect(st.turns.length).toBeGreaterThanOrEqual(1)
      const last = st.turns[st.turns.length - 1]
      expect(last?.assistant.text).toBe('done')
    })
  })
})
