import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSubscription } from 'observable-hooks'
import { EMPTY, from, timer } from 'rxjs'
import { catchError, map, scan, switchMap, takeWhile, concatMap } from 'rxjs/operators'
import type { ResumeConversationResponse } from './api'
import { chatApi } from './api'
import { chatTurnActions } from '../stores/chat-turns'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { deriveResumeCapabilities, deriveResumeOverrides } from '@/features/codex-chat/utils/resume-config'
import { useChatResumeStore, chatResumeActions } from '../stores/chat-resume'

export function useResumeAndPoll(
  routeConversationKey: string | undefined,
  opts?: { navigate?: (to: string, options?: { replace?: boolean }) => void }
) {
  const banner = useChatResumeStore((s) => s.banner)
  const polling = useChatResumeStore((s) => s.polling)
  const pollStartAt = useChatResumeStore((s) => s.pollStartAt)
  const skipResumeKey = useChatResumeStore((s) => s.skipResumeKey)
  const resumeProcessed = useChatResumeStore((s) => s.resumeProcessed)
  const queryClient = useQueryClient()

  const notifyConversationCreated = (newId: string) => {
    chatResumeActions.notifyConversationCreated(newId)
  }

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
    chatResumeActions.processResumeResult(result, routeConversationKey, opts?.navigate)
  }, [resumeQuery.data, routeConversationKey, opts?.navigate])

  useEffect(() => {
    if (!resumeQuery.error) return
    const message = (resumeQuery.error as Error)?.message ?? '恢复会话失败'
    chatResumeActions.setBanner({ kind: 'error', message })
    if (opts?.navigate) opts.navigate('/chat', { replace: true })
  }, [resumeQuery.error, opts])

  const pollCid = resumeQuery.data?.conversationId
  const poll$ = useMemo(() => {
    const cid = pollCid
    const base = useChatResumeStore.getState().resumeBaseHistory
    if (!polling || !cid || !base || routeConversationKey !== cid) return EMPTY
    const initialMs = Number((import.meta as any).env?.VITE_CHAT_POLL_MS ?? 5000)
    const incMs = Number((import.meta as any).env?.VITE_CHAT_POLL_INC_MS ?? 2000)
    const maxPolls = Number((import.meta as any).env?.VITE_CHAT_POLL_MAX_TIMES ?? 5)
    const delays: number[] = Array.from({ length: Math.max(1, maxPolls) }, (_, i) => initialMs + i * incMs)
    return from(delays).pipe(
      concatMap((ms) => timer(ms)),
      switchMap(() => from(chatApi.debugCodex({ limit: 1000, includeChat: true })).pipe(
        map((res: any) => (Array.isArray(res?.events) ? res.events : [])),
        catchError(() => from([[] as any[]]))
      )),
      map((arr: any[]) =>
        arr
          .filter((e: any) => typeof e?.method === 'string' && e.method.startsWith('chat.'))
          .filter((e: any) => e?.params?.conversationId == null || e.params.conversationId === cid)
          .map((e: any) => ({
            method: e.method as string,
            params: e.params as Record<string, unknown> | undefined
          }))
      ),
      scan(
        (acc, events) => {
          const curLen = events.length
          const noChange = curLen <= acc.lastLen ? acc.noChange + 1 : 0
          const stop = noChange >= 4
          return { events, lastLen: curLen, noChange, stop }
        },
        {
          events: [] as Array<{ method: string; params?: Record<string, unknown> }>,
          lastLen: 0,
          noChange: 0,
          stop: false
        }
      ),
      takeWhile((s) => !s.stop, true)
    )
  }, [polling, pollCid, routeConversationKey])

  useSubscription(poll$, ({ events, stop }) => {
    const cid = pollCid
    const base = useChatResumeStore.getState().resumeBaseHistory
    if (!cid || !base) return
    if ((base?.length || 0) === 0 && (events?.length || 0) === 0) {
      // 无基线且无事件，不要重建，避免清空已有 WS 回显
      return
    }
    chatTurnActions.loadSnapshot(base, events)
    queryClient.setQueryData(
      ['chat', 'sessionSnapshot', cid],
      { conversationId: cid, history: base, events, updatedAt: Date.now() }
    )
    if (stop) chatResumeActions.stopPolling()
  })

  return {
    banner,
    pendingConversationId: useChatResumeStore((s) => s.pendingConversationId),
    notifyConversationCreated,
    setBanner: chatResumeActions.setBanner
  }
}
