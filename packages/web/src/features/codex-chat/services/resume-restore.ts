import { useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ResumeConversationResponse } from './api'
import { chatApi } from './api'
import { chatTurnActions } from '../stores/chat-turns'
import { useChatResumeStore, chatResumeActions } from '../stores/chat-resume'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { deriveResumeCapabilities, deriveResumeOverrides } from '@/features/codex-chat/utils/resume-config'

type Options = { navigate?: NavigateFunction }

export function useResumeAndPoll(routeConversationKey: string | undefined, opts?: Options) {
  const banner = useChatResumeStore((s) => s.banner)
  const skipResumeKey = useChatResumeStore((s) => s.skipResumeKey)

  const allowResume = Boolean(routeConversationKey && skipResumeKey !== routeConversationKey)

  const resumeQuery = useQuery<ResumeConversationResponse, Error>({
    queryKey: ['chat', 'session', routeConversationKey] as const,
    enabled: allowResume,
    staleTime: 0,
    queryFn: async () => {
      if (!routeConversationKey) throw new Error('缺少会话 ID')
      return chatApi.resumeByConversationId(routeConversationKey, { includeHistory: true })
    }
  })

  useEffect(() => {
    chatResumeActions.setPending(resumeQuery.isFetching ? routeConversationKey ?? null : null)
  }, [resumeQuery.isFetching, routeConversationKey])

  useEffect(() => {
    const result = resumeQuery.data
    if (!result) return
    if (useChatResumeStore.getState().resumeProcessed === result.conversationId) return
    chatResumeActions.markResumeProcessed(result.conversationId)

    const history = (result.history ?? []).map((entry: any) => ({
      role: entry.role,
      text: entry.text ?? '',
      reasoning: entry.reasoning ?? undefined
    }))
    const events = Array.isArray(result.events)
      ? result.events.filter((ev) => ev && typeof ev.method === 'string')
      : []

    chatTurnActions.reset()
    codexChatProviderActions.resetSession(result.conversationId)
    chatTurnActions.setConversationId(result.conversationId)
    chatTurnActions.loadSnapshot(history, events as any)
    useChatResumeStore.getState().setResumeBaseHistory(history)

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

    chatResumeActions.setBanner({ kind: 'info', message: '已恢复到历史会话' })
    if (opts?.navigate && result.conversationId && result.conversationId !== routeConversationKey) {
      opts.navigate(`/chat/${encodeURIComponent(result.conversationId)}`, { replace: true })
    }
  }, [resumeQuery.data, routeConversationKey, opts])

  useEffect(() => {
    if (!resumeQuery.error) return
    const message = (resumeQuery.error as Error)?.message ?? '恢复会话失败'
    chatResumeActions.setBanner({ kind: 'error', message })
    if (opts?.navigate) opts.navigate('/chat', { replace: true })
  }, [resumeQuery.error, opts])

  return {
    banner,
    pendingConversationId: useChatResumeStore((s) => s.pendingConversationId),
    notifyConversationCreated: chatResumeActions.notifyConversationCreated,
    setBanner: chatResumeActions.setBanner
  }
}
