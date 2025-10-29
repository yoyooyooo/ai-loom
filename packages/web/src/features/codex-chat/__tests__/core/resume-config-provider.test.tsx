import React, { useEffect } from 'react'
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { useResumeAndPoll } from '@/features/codex-chat/services/resume-restore'
import { chatTurnActions } from '@/features/codex-chat/stores/chat-turns'
import { chatApi } from '@/features/codex-chat/services/api'
import { codexChatProviderActions, getCodexSessionState, useCodexChatProviderStore } from '@/stores/codex-chat-provider'

function Host({ conversationKey }: { conversationKey: string }) {
  useResumeAndPoll(conversationKey)
  return null
}

function renderHost(conversationKey: string) {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <Host conversationKey={conversationKey} />
    </QueryClientProvider>
  )
}

describe('Resume 配置 → Provider Store（overrides/capabilities）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    codexChatProviderActions.resetAll()
    vi.spyOn(chatApi, 'getConfig').mockResolvedValue({
      models: [],
      defaults: { model: 'm', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    } as any)
  })
  afterEach(() => {
    chatTurnActions.reset()
    codexChatProviderActions.resetAll()
    vi.restoreAllMocks()
  })

  it('将 resume.config 写入默认会话与目标会话', async () => {
    vi.spyOn(chatApi, 'resumeByConversationId').mockResolvedValue({
      conversationId: 'conv-cfg',
      history: [],
      events: [],
      config: {
        model: 'm2',
        approvalPolicy: 'on-failure',
        sandbox: { mode: 'danger-full-access' },
        overrides: { model: 'm-override', approvalPolicy: 'untrusted', sandboxMode: 'read-only' }
      }
    } as any)

    renderHost('conv-cfg')

    await waitFor(() => {
      const s = useCodexChatProviderStore.getState()
      const def = getCodexSessionState(s, undefined)
      const cur = getCodexSessionState(s, 'conv-cfg')
      // overrides 取 overrides 优先
      expect(def.overrides).toEqual({ model: 'm-override', approvalPolicy: 'untrusted', sandboxMode: 'read-only' })
      expect(cur.overrides).toEqual({ model: 'm-override', approvalPolicy: 'untrusted', sandboxMode: 'read-only' })
      // capabilities.model 取 config.model
      expect(def.capabilities.model).toBe('m2')
      expect(cur.capabilities.model).toBe('m2')
      // extra.resumeConfig 存在
      expect(def.capabilities.extra?.resumeConfig).toBeTruthy()
      expect(cur.capabilities.extra?.resumeConfig).toBeTruthy()
    })
  })
})

