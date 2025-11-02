import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { HistoryList } from '@/features/codex-chat/components/history-list'
import { CodexChatPanel } from '@/features/codex-chat/components/chat-panel'
import type { ConversationListItem } from '@/features/codex-chat/services/api'
import { chatApi } from '@/features/codex-chat/services/api'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors,
  selectConversation
} from '@/features/codex-chat/stores/chat-turns'
import { buildHistoryTree } from '@/features/codex-chat/utils/history-tree'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { useChatHistoryInvalidator } from '@/features/codex-chat/ws-invalidators/history-invalidator'
import { hydrateConversation } from '@/features/codex-chat/services/conversation-session'
import type { Subscription } from 'rxjs'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { ChatTopToolbar } from '@/features/codex-chat/components/chat-top-toolbar'

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
  const qc = useQueryClient()
  const params = useParams<{ conversationId?: string }>()
  const conversationId = useChatTurnStore((state) => state.conversationId)
  const generating = useChatTurnStore((state) => chatTurnSelectors.currentSlice(state).generating)
  const routeConversationKey = useMemo(
    () => decodeParam(params.conversationId),
    [params.conversationId]
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

  const historyItems = useMemo(() => data?.pages.flatMap((page) => page.items ?? []) ?? [], [data])
  const historyNodes = useMemo(() => buildHistoryTree(historyItems), [historyItems])

  const computedActiveConversationId = routeConversationKey ?? conversationId

  const resumeCommand = computedActiveConversationId
    ? `codex resume ${computedActiveConversationId}`
    : ''
  const { isCopied, handleCopy } = useCopyToClipboard({
    text: resumeCommand,
    copyMessage: resumeCommand ? `已复制：${resumeCommand}` : '已复制'
  })

  const lastHydratedRef = useRef<string | null>(null)
  const wsSubRef = useRef<Subscription | null>(null)
  useEffect(() => {
    if (!routeConversationKey) {
      // 保持 /chat 空态：不选中会话，不订阅任何会话
      chatTurnActions.setWsAutoSelectGuard(true)
      chatTurnActions.setConversationId(undefined)
      codexChatProviderActions.resetSession(undefined)
      const prev = lastHydratedRef.current
      if (prev) {
        try {
          wsSubRef.current?.unsubscribe()
        } catch {}
        wsSubRef.current = null
        lastHydratedRef.current = null
      }
      return
    }

    const cid = routeConversationKey
    if (lastHydratedRef.current && lastHydratedRef.current !== cid) {
      try {
        wsSubRef.current?.unsubscribe()
      } catch {}
      wsSubRef.current = null
    }
    lastHydratedRef.current = cid

    chatTurnActions.setWsAutoSelectGuard(false)
    selectConversation(cid, { reason: 'route' })

    hydrateConversation(cid, { tail: 128 })
      .then((sub) => {
        wsSubRef.current = sub ?? null
      })
      .catch((error) => {
        console.warn('[chat] hydrate failed', error)
      })

    return () => {
      if (lastHydratedRef.current === cid) {
        try {
          wsSubRef.current?.unsubscribe()
        } catch {}
        wsSubRef.current = null
        lastHydratedRef.current = null
      }
    }
  }, [routeConversationKey])

  // 安装聊天历史的 WS 失效器：新会话/收束后自动刷新历史列表（observable-hooks）
  useChatHistoryInvalidator(qc)

  const inProgressConversationId = generating
    ? (computedActiveConversationId ?? undefined)
    : undefined

  const handleConversationCreated = useCallback(
    async (newId: string) => {
      // 1) 立即导航到新会话
      navigate(`/chat/${encodeParam(newId)}`)

      // 2) 乐观地把“占位会话”插入到历史第一页，避免列表短暂缺失
      try {
        const qk = ['chat', 'history', { pageSize: 20 }] as const
        qc.setQueryData<InfiniteData<ConversationListPage, string | null> | undefined>(
          qk,
          (prev) => {
            const placeholder = {
              path: '',
              preview: '（新会话）',
              timestamp: new Date().toISOString(),
              model: undefined,
              conversationId: newId,
              parentId: null,
              rootId: null,
              depth: 0,
              createdAt: new Date().toISOString(),
              turns: null,
              __optimistic: true
            } as unknown as ConversationListItem

            if (!prev || !Array.isArray(prev.pages) || prev.pages.length === 0) {
              return {
                pages: [{ items: [placeholder], nextCursor: null }],
                pageParams: [null]
              }
            }
            const exists = prev.pages.some((p) =>
              (p.items || []).some((it) => it.conversationId === newId)
            )
            if (exists) return prev
            const first = prev.pages[0]
            const updatedFirst = { ...first, items: [placeholder, ...(first.items || [])] }
            return { ...prev, pages: [updatedFirst, ...prev.pages.slice(1)] }
          }
        )
        // 纯事件范式：不再使用时间 TTL 清理占位，由事件侧负责（见 useChatHistoryInvalidator）
      } catch (e) {
        // 忽略缓存更新失败，不影响后续 refetch
      }

      // 3) 立刻拉取一次；后续刷新改由 WS 事件驱动（invalidator 已监听 chat.*）
      try {
        const res = await refetch()
        void res
      } catch (error) {
        console.warn('[chat] history refetch failed', error)
      }

      // 3.1) 100ms 兜底：Codex 列表索引偶发略滞后，轻量再拉一次
      setTimeout(() => {
        try {
          refetch()
        } catch {}
      }, 100)
      // 4) 导航到新会话（确保路由键存在，从而触发 hydrate + WS 订阅）
      try {
        navigate(`/chat/${encodeParam(newId)}`)
      } catch {}
    },
    [navigate, refetch, qc]
  )

  const handleSelectHistory = useCallback(
    async (item: ConversationListItem) => {
      const key = item.conversationId ?? item.path
      if (!key) return
      if (computedActiveConversationId === key && !generating) return

      // 并行多会话：不再强制中止当前会话，直接切换到目标会话（分片模型内互不干扰）
      selectConversation(key, { reason: 'route' })
      // 收束由各自会话的 chat.* 事件驱动；必要时由后端 watchdog 自动降级

      if (routeConversationKey !== key) {
        navigate(`/chat/${encodeParam(key)}`)
      }
    },
    [computedActiveConversationId, generating, routeConversationKey, navigate]
  )

  const handleDeleteHistory = useCallback(
    async (item: ConversationListItem) => {
      const key = item.conversationId ?? item.path
      if (!item.path || !key) return
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
          inProgressConversationId={inProgressConversationId}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          onDelete={handleDeleteHistory}
        />
      </aside>
      <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-border bg-muted/40">
            <ChatTopToolbar
              kind="info"
              conversationId={computedActiveConversationId ?? null}
              onCopy={resumeCommand ? handleCopy : undefined}
              copied={isCopied}
            />
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <CodexChatPanel onConversationCreated={handleConversationCreated} />
          </div>
        </div>
      </main>
    </div>
  )
}
