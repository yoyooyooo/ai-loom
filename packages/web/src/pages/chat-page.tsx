import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { HistoryList } from '@/features/codex-chat/components/history-list'
import {
  CodexChatPanel,
  type ConversationCreatedPayload
} from '@/features/codex-chat/components/chat-panel'
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
import { useObservableState } from 'observable-hooks'
import {
  generatingState$,
  getGeneratingSnapshot,
  seedGenerating
} from '@/features/codex-chat/services/generating-aggregator'

type ConversationListPage = {
  items: ConversationListItem[]
  nextCursor?: string | null
  codexUnavailable?: boolean
}
type OptimisticConversationListItem = ConversationListItem & {
  __optimistic?: boolean
  inProgress?: boolean | null
}

const HISTORY_PAGE_SIZE = 20
const HISTORY_QUERY_KEY = ['chat', 'history', { pageSize: HISTORY_PAGE_SIZE }] as const

const compareHistoryTimestampDesc = (a: ConversationListItem, b: ConversationListItem) => {
  const at = (a.timestamp ?? a.createdAt ?? '') as string
  const bt = (b.timestamp ?? b.createdAt ?? '') as string
  if (at === bt) return 0
  return at > bt ? -1 : 1
}

const upsertHistoryOptimistic = (
  prev: InfiniteData<ConversationListPage, string | null> | undefined,
  entry: OptimisticConversationListItem
): InfiniteData<ConversationListPage, string | null> => {
  if (!entry.conversationId) {
    if (prev) return prev
    return {
      pages: [{ items: [entry], nextCursor: null }],
      pageParams: [null]
    }
  }

  if (!prev || !Array.isArray(prev.pages) || prev.pages.length === 0) {
    return {
      pages: [{ items: [entry], nextCursor: null }],
      pageParams: prev?.pageParams?.length ? [...prev.pageParams] : [null]
    }
  }

  const pages = prev.pages.map((page) => ({
    ...page,
    items: Array.isArray(page.items) ? [...page.items] : []
  }))

  let handled = false
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    const items = page.items as OptimisticConversationListItem[]
    const idx = items.findIndex((it) => it.conversationId === entry.conversationId)
    if (idx !== -1) {
      const existing = items[idx]
      const merged: OptimisticConversationListItem = {
        ...existing,
        ...entry,
        __optimistic: entry.__optimistic ?? existing.__optimistic
      }
      const nextItems = items.slice()
      nextItems[idx] = merged
      pages[pageIndex] = { ...page, items: nextItems }
      handled = true
      break
    }
  }

  if (!handled) {
    const first = pages[0]
    const nextItems = [entry, ...first.items]
    const limited = HISTORY_PAGE_SIZE > 0 ? nextItems.slice(0, HISTORY_PAGE_SIZE) : nextItems
    pages[0] = { ...first, items: limited }
  }

  return { ...prev, pages }
}
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
  const generating = useChatTurnStore((state) => chatTurnSelectors.currentSlice(state).generating)
  const [optimisticHistory, setOptimisticHistory] = useState<Record<string, OptimisticConversationListItem>>({})
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
    typeof HISTORY_QUERY_KEY,
    string | null
  >({
    queryKey: HISTORY_QUERY_KEY,
    initialPageParam: null,
    queryFn: ({ pageParam }) =>
      chatApi.listConversations({ pageSize: HISTORY_PAGE_SIZE, cursor: pageParam ?? undefined }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null
  })

  const historyItemsFromQuery = useMemo(
    () => data?.pages.flatMap((page) => page.items ?? []) ?? [],
    [data]
  )

  useEffect(() => {
    if (historyItemsFromQuery.length === 0) return
    setOptimisticHistory((prev) => {
      let patched = false
      const next = { ...prev }
      for (const item of historyItemsFromQuery) {
        const cid = item.conversationId
        if (cid && next[cid]) {
          delete next[cid]
          patched = true
        }
      }
      return patched ? next : prev
    })
  }, [historyItemsFromQuery])

  const historyItems = useMemo(() => {
    if (historyItemsFromQuery.length === 0 && Object.keys(optimisticHistory).length === 0) {
      return []
    }
    const merged: ConversationListItem[] = [...historyItemsFromQuery]
    const existing = new Set(
      historyItemsFromQuery
        .map((item) => item.conversationId)
        .filter((cid): cid is string => typeof cid === 'string' && cid.length > 0)
    )
    for (const value of Object.values(optimisticHistory)) {
      const cid = value.conversationId
      if (!cid || existing.has(cid)) continue
      merged.push(value)
    }
    merged.sort(compareHistoryTimestampDesc)
    return merged
  }, [historyItemsFromQuery, optimisticHistory])

  const historyNodes = useMemo(() => buildHistoryTree(historyItems), [historyItems])

  const fallbackSeededKeysRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const nextKeys = new Set<string>()
    for (const item of historyItems) {
      const cid = (item.conversationId || '').trim()
      if (!cid || !item.inProgress) continue
      const providerId = (item.providerId || 'codex').trim()
      const key = providerId ? `${providerId}|${cid}` : cid
      nextKeys.add(key)
      seedGenerating(key, true)
    }
    const prevKeys = fallbackSeededKeysRef.current
    for (const key of prevKeys) {
      if (!nextKeys.has(key)) {
        seedGenerating(key, false)
      }
    }
    fallbackSeededKeysRef.current = new Set(nextKeys)
  }, [historyItems])

  const computedActiveConversationId = routeConversationKey

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

    hydrateConversation(cid, { tail: 128, forceBaseline: true })
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

  const handleOptimisticFailure = useCallback((cid: string) => {
    if (!cid) return
    setOptimisticHistory((prev) => {
      if (!prev[cid]) return prev
      const next = { ...prev }
      delete next[cid]
      return next
    })
  }, [])

  // 安装聊天历史的 WS 失效器：新会话/收束后自动刷新历史列表
  useChatHistoryInvalidator(qc, { onOptimisticFailure: handleOptimisticFailure })

  const [generatingState] = useObservableState(() => generatingState$(), getGeneratingSnapshot())
  const generatingKeys = useMemo(() => {
    const entries = Object.entries(generatingState.byKey || {})
    const keys = entries
      .filter(([, entry]) => entry?.generating)
      .map(([key]) => key)
    return new Set(keys)
  }, [generatingState])

  const handleConversationCreated = useCallback(
    async ({
      conversationId: newId,
      preview,
      model,
      providerId,
      timestamp,
      createdAt
    }: ConversationCreatedPayload) => {
      if (!newId) return

      navigate(`/chat/${encodeParam(newId)}`)

      const issuedAt = timestamp ?? createdAt ?? new Date().toISOString()
      const optimisticItem: OptimisticConversationListItem = {
        path: '',
        preview: preview && preview.trim().length > 0 ? preview : '（生成中）',
        timestamp: issuedAt,
        model: model ?? undefined,
        providerId: providerId ?? undefined,
        conversationId: newId,
        parentId: null,
        rootId: null,
        depth: 0,
        createdAt: createdAt ?? issuedAt,
        turns: null,
        inProgress: true,
        __optimistic: true
      }

      setOptimisticHistory((prev) => ({ ...prev, [newId]: optimisticItem }))
      qc.setQueryData<InfiniteData<ConversationListPage, string | null> | undefined>(
        HISTORY_QUERY_KEY,
        (prev) => upsertHistoryOptimistic(prev, optimisticItem)
      )

      try {
        await refetch()
      } catch (error) {
        console.warn('[chat] history refetch failed', error)
      }

      setTimeout(() => {
        void refetch().catch(() => {})
      }, 100)
    },
    [navigate, refetch, qc, setOptimisticHistory]
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
      if (!item.conversationId || !key) return
      await chatApi.deleteConversation(item.conversationId, item.providerId)
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
          generatingKeys={generatingKeys}
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
