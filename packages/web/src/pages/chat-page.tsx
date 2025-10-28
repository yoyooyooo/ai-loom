import { useCallback, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { HistoryList } from '@/features/codex-chat/components/history-list'
import { CodexChatPanel } from '@/features/codex-chat/components/chat-panel'
import type { ConversationListItem } from '@/features/codex-chat/services/api'
import { chatApi } from '@/features/codex-chat/services/api'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import type { ResumeBanner } from '@/features/codex-chat/types'
import { buildHistoryTree } from '@/features/codex-chat/utils/history-tree'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { useResumeAndPoll } from '@/features/codex-chat/services/resume-manager'

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
  const routeConversationKey = useMemo(() => decodeParam(params.conversationId), [params.conversationId])
  const { banner, setBanner, pendingConversationId, notifyConversationCreated } = useResumeAndPoll(
    routeConversationKey,
    { navigate: (to, options) => navigate(to, options) }
  )

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

  const computedActiveConversationId = routeConversationKey ?? conversationId

  useEffect(() => {
    if (!routeConversationKey) {
      chatTurnActions.reset()
      codexChatProviderActions.resetSession(undefined)
      setBanner(null)
    }
  }, [routeConversationKey, setBanner])

  const inProgressConversationId = generating ? (computedActiveConversationId ?? undefined) : undefined

  const handleConversationCreated = useCallback(
    async (newId: string) => {
      notifyConversationCreated(newId)
      setBanner(null)
      navigate(`/chat/${encodeParam(newId)}`)
      try {
        await refetch()
      } catch (error) {
        console.warn('[chat] history refetch failed', error)
      }
    },
    [navigate, refetch, notifyConversationCreated, setBanner]
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
