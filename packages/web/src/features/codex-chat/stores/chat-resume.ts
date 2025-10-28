import { create } from 'zustand'
import type { ResumeBanner } from '@/features/codex-chat/types'
import type { ResumeConversationResponse } from '@/features/codex-chat/services/api'
import { chatApi } from '@/features/codex-chat/services/api'
import { chatTurnActions } from './chat-turns'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { deriveResumeCapabilities, deriveResumeOverrides } from '@/features/codex-chat/utils/resume-config'

export type SnapshotHistoryItem = {
  role: 'user' | 'assistant' | 'reasoning'
  text: string
  reasoning?: string | null
}

type ChatResumeState = {
  banner: ResumeBanner
  skipResumeKey: string | null
  resumeProcessed: string | null
  pendingConversationId: string | null
  // 轮询相关
  polling: boolean
  pollStartAt: number
  pollNoChange: number
  pollLastEventsLen: number
  // 恢复基线（history-only），用于后续重放 events
  resumeBaseHistory: SnapshotHistoryItem[] | null
}

type ChatResumeActions = {
  setBanner: (b: ResumeBanner) => void
  setPending: (cid: string | null) => void
  notifyConversationCreated: (newId: string) => void
  markResumeProcessed: (cid: string | null) => void
  resetConversation: () => void
  setResumeBaseHistory: (items: SnapshotHistoryItem[] | null) => void
  startPolling: () => void
  stopPolling: () => void
  setPollLastLen: (n: number) => void
  resetPollNoChange: () => void
  incPollNoChange: () => void
  processResumeResult: (
    result: ResumeConversationResponse,
    routeConversationKey?: string,
    navigate?: (to: string, options?: { replace?: boolean }) => void
  ) => Promise<void>
}

type Store = ChatResumeState & ChatResumeActions

export const useChatResumeStore = create<Store>((set, get) => ({
  banner: null,
  skipResumeKey: null,
  resumeProcessed: null,
  pendingConversationId: null,
  polling: false,
  pollStartAt: 0,
  pollNoChange: 0,
  pollLastEventsLen: 0,
  resumeBaseHistory: null,
  setBanner: (b) => set({ banner: b }),
  setPending: (cid) => set({ pendingConversationId: cid }),
  notifyConversationCreated: (newId) => set({ skipResumeKey: newId, resumeProcessed: null, banner: null }),
  markResumeProcessed: (cid) => set({ resumeProcessed: cid }),
  resetConversation: () => set({ banner: null, resumeProcessed: null, skipResumeKey: null, resumeBaseHistory: null }),
  setResumeBaseHistory: (items) => set({ resumeBaseHistory: items }),
  startPolling: () => set({ polling: true, pollStartAt: Date.now(), pollNoChange: 0, pollLastEventsLen: 0 }),
  stopPolling: () => set({ polling: false }),
  setPollLastLen: (n) => set({ pollLastEventsLen: n }),
  resetPollNoChange: () => set({ pollNoChange: 0 }),
  incPollNoChange: () => set({ pollNoChange: get().pollNoChange + 1 }),
  async processResumeResult(result, routeKey, navigate) {
    if (!result) return
    if (get().resumeProcessed === result.conversationId) return
    set({ resumeProcessed: result.conversationId })
    chatTurnActions.reset()
    codexChatProviderActions.resetSession(result.conversationId)
    chatTurnActions.setConversationId(result.conversationId)
    const history = (result.history ?? []).map((entry: any) => ({
      role: entry.role,
      text: entry.text ?? '',
      reasoning: entry.reasoning ?? undefined
    }))
    set({ resumeBaseHistory: history })
    let events = (result.events ?? []).map((entry: any) => ({
      method: entry?.method || '',
      params: entry?.params ?? undefined
    }))
    if (events.length === 0) {
      try {
        const debug = await chatApi.debugCodex({ limit: 800, includeChat: true })
        const arr = Array.isArray((debug as any)?.events) ? (debug as any).events : []
        events = arr
          .filter((e: any) => typeof e?.method === 'string' && e.method.startsWith('chat.'))
          .filter(
            (e: any) => !result.conversationId || e?.params?.conversationId == null || e.params.conversationId === result.conversationId
          )
          .map((e: any) => ({ method: e.method as string, params: e.params as Record<string, unknown> | undefined }))
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[chat] debugCodex fetch events failed', error)
      }
    }
    chatTurnActions.loadSnapshot(history, events)
    const resumeConfig = (result as any).config ?? null
    if (resumeConfig) {
      const overridePatch = deriveResumeOverrides(resumeConfig)
      if (Object.keys(overridePatch).length > 0) {
        codexChatProviderActions.setOverrides(undefined, overridePatch)
        codexChatProviderActions.setOverrides(result.conversationId, overridePatch)
      }
      const capabilityPatch = deriveResumeCapabilities(resumeConfig)
      if (Object.keys(capabilityPatch).length > 0) {
        codexChatProviderActions.setCapabilities(undefined, capabilityPatch)
        codexChatProviderActions.setCapabilities(result.conversationId, capabilityPatch)
      }
    }
    set({ banner: { kind: 'info', message: '已恢复到历史会话' } })
    if (navigate && result.conversationId && result.conversationId !== routeKey) {
      navigate(`/chat/${encodeURIComponent(result.conversationId)}`, { replace: true })
    }
    if ((result as any).inProgress && result.conversationId === routeKey) {
      set({ polling: true, pollStartAt: Date.now(), pollNoChange: 0, pollLastEventsLen: 0 })
    } else {
      set({ polling: false })
    }
  }
}))

export const chatResumeActions: ChatResumeActions = {
  setBanner: (b) => useChatResumeStore.getState().setBanner(b),
  setPending: (cid) => useChatResumeStore.getState().setPending(cid),
  notifyConversationCreated: (id) => useChatResumeStore.getState().notifyConversationCreated(id),
  markResumeProcessed: (cid) => useChatResumeStore.getState().markResumeProcessed(cid),
  resetConversation: () => useChatResumeStore.getState().resetConversation(),
  setResumeBaseHistory: (items) => useChatResumeStore.getState().setResumeBaseHistory(items),
  startPolling: () => useChatResumeStore.getState().startPolling(),
  stopPolling: () => useChatResumeStore.getState().stopPolling(),
  setPollLastLen: (n) => useChatResumeStore.getState().setPollLastLen(n),
  resetPollNoChange: () => useChatResumeStore.getState().resetPollNoChange(),
  incPollNoChange: () => useChatResumeStore.getState().incPollNoChange(),
  processResumeResult: (result, key, navigate) =>
    useChatResumeStore.getState().processResumeResult(result, key, navigate)
}
