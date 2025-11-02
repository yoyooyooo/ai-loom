import React, { useEffect } from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  hydrateConversation,
  resetConversationSessionForTests
} from '@/features/codex-chat/services/conversation-session'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { chatApi } from '@/features/codex-chat/services/api'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

function Host({ conversationKey }: { conversationKey?: string }) {
  useEffect(() => {
    const off = subscribeChatEvents()
    return () => off()
  }, [])

  useEffect(() => {
    if (!conversationKey) return
    hydrateConversation(conversationKey, { tail: 64 }).catch((error) => {
      console.warn('[test] hydrate failed', error)
    })
  }, [conversationKey])

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
    resetConversationSessionForTests()
    vi.spyOn(chatApi, 'getConfig').mockResolvedValue({
      models: [],
      defaults: { model: 'm', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    } as any)
  })
  afterEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
    resetConversationSessionForTests()
    vi.restoreAllMocks()
  })

  it('已完成会话刷新：turns（含 assistant）渲染为稳定 turns', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-c',
      turns: [
        {
          id: 'turn-1',
          seq: 1,
          conversationId: 'conv-c',
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

    renderHost('conv-c')

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      const slice = chatTurnSelectors.sliceById('conv-c')(st)
      expect(slice.turns.length).toBe(1)
      expect(slice.turns[0]?.assistant.text).toBe('world')
    })
  })

  it('未完成会话：turns 仅用户 → 接续 WS 完成同一轮', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-p',
      turns: [
        {
          id: 'turn-1',
          seq: 1,
          conversationId: 'conv-p',
          status: 'streaming',
          user: { text: 'hi', ts: '' },
          assistant: { text: '' },
          steps: []
        }
      ],
      inProgress: true,
      turnsSchemaVersion: 1,
      uptoEventId: 0
    } as any)

    renderHost('conv-p')

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      const slice = chatTurnSelectors.sliceById('conv-p')(st)
      expect(slice.turns.length).toBe(1)
      expect(slice.turns[0]?.user.text).toBe('hi')
    })

    __emit('chat.message.delta', { conversationId: 'conv-p', delta: 'stream...' })
    __emit('chat.message.completed', { conversationId: 'conv-p', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-p' })

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      const slice = chatTurnSelectors.sliceById('conv-p')(st)
      const last = slice.turns[slice.turns.length - 1]
      expect(last?.assistant.text || '').toContain('OK')
    })
  })

  it('新会话：无 resume，仅 WS 首帧携带 conversationId 即可渲染', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-n1',
      turns: [],
      inProgress: false,
      turnsSchemaVersion: 1,
      uptoEventId: 0
    } as any)

    renderHost('conv-n1')
    __emit('chat.message.delta', { conversationId: 'conv-n1', delta: 'hello' })
    __emit('chat.message.completed', { conversationId: 'conv-n1', text: 'done' })
    __emit('chat.turn.complete', { conversationId: 'conv-n1' })

    await waitFor(() => {
      const st = useChatTurnStore.getState()
      const slice = chatTurnSelectors.sliceById('conv-n1')(st)
      expect(slice.turns.length).toBeGreaterThanOrEqual(1)
      const last = slice.turns[slice.turns.length - 1]
      expect(last?.assistant.text).toBe('done')
    })
  })
})
