import { create } from 'zustand'
import type { ResumeBanner } from '@/features/codex-chat/types'
import type { ResumeConversationResponse } from '@/features/codex-chat/services/api'
import { chatTurnActions } from './chat-turns'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { deriveResumeCapabilities, deriveResumeOverrides } from '@/features/codex-chat/utils/resume-config'
import { ws } from '@/lib/ws/singleton'

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
  // 恢复基线（history-only），用于后续调试或手动重放
  resumeBaseHistory: SnapshotHistoryItem[] | null
}

type ChatResumeActions = {
  setBanner: (b: ResumeBanner) => void
  setPending: (cid: string | null) => void
  notifyConversationCreated: (newId: string) => void
  markResumeProcessed: (cid: string | null) => void
  resetConversation: () => void
  setResumeBaseHistory: (items: SnapshotHistoryItem[] | null) => void
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
  resumeBaseHistory: null,
  setBanner: (b) => set({ banner: b }),
  setPending: (cid) => set({ pendingConversationId: cid }),
  notifyConversationCreated: (newId) => set({ skipResumeKey: newId, resumeProcessed: null, banner: null }),
  markResumeProcessed: (cid) => set({ resumeProcessed: cid }),
  resetConversation: () => set({ banner: null, resumeProcessed: null, skipResumeKey: null, resumeBaseHistory: null }),
  setResumeBaseHistory: (items) => set({ resumeBaseHistory: items }),
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
    const normalizedEvents = Array.isArray(result.events)
      ? result.events.filter((ev) => ev && typeof ev.method === 'string')
      : []
    set({ resumeBaseHistory: history })
    chatTurnActions.loadSnapshot(history, normalizedEvents as any)
    if (normalizedEvents.length > 0) {
      const maxEventId = normalizedEvents.reduce((max, ev) => {
        const raw = (ev as any)?.params?.eventId
        const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10)
        return Number.isFinite(parsed) && parsed > max ? parsed : max
      }, 0)
      if (maxEventId > 0) ws.primeConversationCursor(result.conversationId, maxEventId)
    }
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
  }
}))

export const chatResumeActions: ChatResumeActions = {
  setBanner: (b) => useChatResumeStore.getState().setBanner(b),
  setPending: (cid) => useChatResumeStore.getState().setPending(cid),
  notifyConversationCreated: (id) => useChatResumeStore.getState().notifyConversationCreated(id),
  markResumeProcessed: (cid) => useChatResumeStore.getState().markResumeProcessed(cid),
  resetConversation: () => useChatResumeStore.getState().resetConversation(),
  setResumeBaseHistory: (items) => useChatResumeStore.getState().setResumeBaseHistory(items),
  processResumeResult: (result, key, navigate) =>
    useChatResumeStore.getState().processResumeResult(result, key, navigate)
}
