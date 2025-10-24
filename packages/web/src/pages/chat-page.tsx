import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query'
import { HistoryList } from '@/features/codex-chat/components/history-list'
import { CodexChatPanel } from '@/features/codex-chat/components/chat-panel'
import type {
  ConversationListItem,
  ChatHistoryItem,
  ResumeConversationResponse
} from '@/features/codex-chat/services/api'
import { chatApi } from '@/features/codex-chat/services/api'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import type { ResumeBanner } from '@/features/codex-chat/types'
import { buildHistoryTree } from '@/features/codex-chat/utils/history-tree'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { deriveResumeCapabilities, deriveResumeOverrides } from '@/features/codex-chat/utils/resume-config'

type ConversationListPage = { items: ConversationListItem[]; nextCursor?: string | null }
const encodeParam = (segment: string) => encodeURIComponent(segment)
const decodeParam = (segment?: string) => {
  if (!segment) return undefined
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export default function ChatPage() {
  const navigate = useNavigate()
  const params = useParams<{ conversationId?: string }>()
  const { conversationId, generating } = useChatTurnStore((state) => ({
    conversationId: state.conversationId,
    generating: state.generating
  }))
  const [banner, setBanner] = useState<ResumeBanner>(null)
  const skipResumeRef = useRef<string | null>(null)
  const resumeProcessedRef = useRef<string | null>(null)

  const {
    data,
    isLoading,
    isFetching,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteQuery<
    ConversationListPage,
    Error,
    InfiniteData<ConversationListPage, string | null>,
    ['chat', 'history', { pageSize: number }],
    string | null
  >({
    queryKey: ['chat', 'history', { pageSize: 20 }] as const,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      chatApi.listConversations({ pageSize: 20, cursor: pageParam ?? undefined }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null
  })

  const historyItems = useMemo(
    () => data?.pages.flatMap((page) => page.items ?? []) ?? [],
    [data]
  )
  const historyNodes = useMemo(() => buildHistoryTree(historyItems), [historyItems])

  const routeConversationKey = useMemo(() => decodeParam(params.conversationId), [params.conversationId])
  const computedActiveConversationId = routeConversationKey ?? conversationId

  useEffect(() => {
    if (!routeConversationKey) {
      chatTurnActions.reset()
      codexChatProviderActions.resetSession(undefined)
      setBanner(null)
      resumeProcessedRef.current = null
    }
  }, [routeConversationKey])

  const allowResume = Boolean(routeConversationKey && skipResumeRef.current !== routeConversationKey)

  const resumeQuery = useQuery<ResumeConversationResponse, Error>({
    queryKey: ['chat', 'session', routeConversationKey] as const,
    enabled: allowResume,
    staleTime: 0,
    queryFn: async () => {
      if (!routeConversationKey) throw new Error('缺少会话 ID')
      return chatApi.resumeByConversationId(routeConversationKey)
    }
  })

  useEffect(() => {
    if (!routeConversationKey && skipResumeRef.current) {
      skipResumeRef.current = null
    }
    if (routeConversationKey && skipResumeRef.current && routeConversationKey !== skipResumeRef.current) {
      skipResumeRef.current = null
    }
  }, [routeConversationKey])

  useEffect(() => {
    setBanner(null)
  }, [routeConversationKey])

  useEffect(() => {
    const result = resumeQuery.data
    if (!result) return
    if (resumeProcessedRef.current === result.conversationId) return
    resumeProcessedRef.current = result.conversationId
    chatTurnActions.reset()
    codexChatProviderActions.resetSession(result.conversationId)
    chatTurnActions.setConversationId(result.conversationId)
    ;(async () => {
      const history = (result.history ?? []).map((entry) => ({
        role: entry.role,
        text: entry.text ?? '',
        reasoning: entry.reasoning ?? undefined
      }))
      let events = (result.events ?? []).map((entry) => ({
        method: entry?.method || '',
        params: entry?.params ?? undefined
      }))
      if (events.length === 0) {
        try {
          const debug = await chatApi.debugCodex({ limit: 800, includeChat: true })
          const arr = Array.isArray((debug as any)?.events) ? (debug as any).events : []
          // 仅取归一化后的 chat.* 且 conversationId 匹配的事件
          events = arr
            .filter((e: any) => typeof e?.method === 'string' && e.method.startsWith('chat.'))
            .filter((e: any) => !result.conversationId || e?.params?.conversationId == null || e.params.conversationId === result.conversationId)
            .map((e: any) => ({ method: e.method as string, params: e.params as Record<string, unknown> | undefined }))
        } catch (error) {
          console.warn('[chat] debugCodex fetch events failed', error)
        }
      }
      chatTurnActions.loadSnapshot(history, events)
    })()

    const resumeConfig = result.config ?? null
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

    setBanner({ kind: 'info', message: '已恢复到历史会话' })
    // 恢复成功后刷新历史列表，以便出现新 fork 的会话并附带 lineage
    try {
      void refetch()
    } catch {}
    if (result.conversationId && result.conversationId !== routeConversationKey) {
      navigate(`/chat/${encodeParam(result.conversationId)}`, { replace: true })
    }
  }, [resumeQuery.data, routeConversationKey, navigate])

  useEffect(() => {
    if (!resumeQuery.error) return
    const message = (resumeQuery.error as Error)?.message ?? '恢复会话失败'
    setBanner({ kind: 'error', message })
    navigate('/chat', { replace: true })
  }, [resumeQuery.error, navigate])

  const pendingConversationId = resumeQuery.isFetching ? routeConversationKey : null

  const inProgressConversationId = generating ? (computedActiveConversationId ?? undefined) : undefined

  const handleConversationCreated = useCallback(
    async (newId: string) => {
      skipResumeRef.current = newId
      resumeProcessedRef.current = null
      setBanner(null)
      navigate(`/chat/${encodeParam(newId)}`)
      try {
        await refetch()
      } catch (error) {
        console.warn('[chat] history refetch failed', error)
      }
    },
    [navigate, refetch]
  )

  const handleSelectHistory = useCallback(
    async (item: ConversationListItem) => {
      const key = item.conversationId ?? item.path
      if (!key) return
      if (pendingConversationId === key) return
      if (computedActiveConversationId === key && !generating) return

      if (generating) {
        const confirmed = window.confirm('当前会话正在生成。是否停止生成并恢复该历史会话？')
        if (!confirmed) return
        if (conversationId) {
          try {
            await chatApi.interrupt(conversationId)
          } catch (error) {
            console.warn('interrupt failed before resume', error)
          }
        }
        chatTurnActions.abortAssistant()
        chatTurnActions.completeTurn()
      }

      resumeProcessedRef.current = null
      setBanner(null)

      if (routeConversationKey !== key) {
        navigate(`/chat/${encodeParam(key)}`)
      }
    },
    [
      pendingConversationId,
      computedActiveConversationId,
      generating,
      conversationId,
      routeConversationKey,
      navigate
    ]
  )

  const handleDeleteHistory = useCallback(
    async (item: ConversationListItem) => {
      const key = item.conversationId ?? item.path
      if (!item.path || !key) return
      setBanner(null)
      await chatApi.deleteConversation(item.path)
      if (computedActiveConversationId === key) {
        chatTurnActions.reset()
        navigate('/chat', { replace: true })
      }
      const result = await refetch()
      if (result.error) throw result.error
    },
    [computedActiveConversationId, navigate, refetch]
  )

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <aside className="flex h-full min-h-0 w-[280px] shrink-0 flex-col overflow-hidden border-r border-border bg-muted/40">
        <HistoryList
          nodes={historyNodes}
          isLoading={isLoading}
          isFetching={isFetching}
          isError={isError}
          empty={!isLoading && !isError && historyNodes.length === 0}
          onRetry={() => refetch()}
          onSelect={handleSelectHistory}
          activeConversationId={computedActiveConversationId ?? undefined}
          pendingConversationId={pendingConversationId}
          inProgressConversationId={inProgressConversationId}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          onDelete={handleDeleteHistory}
        />
      </aside>
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          {banner ? (
            <div
              className={
                banner.kind === 'error'
                  ? 'bg-destructive/15 text-destructive px-4 py-2 text-sm'
                  : 'bg-muted px-4 py-2 text-sm text-muted-foreground'
              }
            >
              {banner.message}
            </div>
          ) : null}
          <div className="flex-1 min-h-0 overflow-hidden">
            <CodexChatPanel onConversationCreated={handleConversationCreated} />
          </div>
        </div>
      </main>
    </div>
  )
}
