import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useInViewport } from 'ahooks'
import { Loader2, Trash2 } from 'lucide-react'
import { cn, formatDateTime, formatDateDay } from '@/lib/utils'
import { EmptyState, LoadingPlaceholder } from '@/components/ui/placeholder'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { ConversationListItem } from '../services/api'
import { chatApi } from '../services/api'
import type { HistoryTreeNode } from '../utils/history-tree'

export type HistoryListProps = {
  nodes: HistoryTreeNode[]
  isLoading: boolean
  isFetching: boolean
  isError: boolean
  empty: boolean
  onRetry?: () => void
  onSelect?: (item: ConversationListItem) => void
  activeConversationId?: string
  pendingConversationId?: string | null
  inProgressConversationId?: string
  hasNextPage?: boolean
  isFetchingNextPage?: boolean
  onLoadMore?: () => void
  onDelete?: (item: ConversationListItem) => Promise<void> | void
}

const INDENT_STEP = 14

export function HistoryList({
  nodes,
  isLoading,
  isFetching,
  isError,
  empty,
  onRetry,
  onSelect,
  activeConversationId,
  pendingConversationId,
  inProgressConversationId,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onDelete
}: HistoryListProps) {
  const info = useMemo(() => {
    if (isLoading || isFetching) return '加载中…'
    if (isError) return '加载失败'
    return null
  }, [isLoading, isFetching, isError])

  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const [loadMoreInView] = useInViewport(loadMoreRef, { threshold: 0, rootMargin: '200px' })
  const hasRequestedMoreRef = useRef(false)

  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [vibeCheck, setVibeCheck] = useState<{
    key: string | null
    loading: boolean
    associated: boolean
    projectId?: string
    taskId?: string
    projectName?: string
    taskTitle?: string
  }>({ key: null, loading: false, associated: false })

  useEffect(() => {
    if (!hasNextPage || !onLoadMore) {
      hasRequestedMoreRef.current = false
      return
    }
    if (loadMoreInView && !isFetchingNextPage && !hasRequestedMoreRef.current) {
      hasRequestedMoreRef.current = true
      onLoadMore()
    } else if (!loadMoreInView) {
      hasRequestedMoreRef.current = false
    }
  }, [hasNextPage, loadMoreInView, isFetchingNextPage, onLoadMore])

  const handleDelete = useCallback(
    async (item: ConversationListItem, opts?: { skipConfirm?: boolean }) => {
      if (!onDelete) return
      const key = item.conversationId ?? item.path
      if (!key || deletingKey) return
      setErrorMessage(null)
      setDeletingKey(key)
      try {
        await onDelete(item)
      } catch (error) {
        const message = (error as Error)?.message ?? '删除会话失败'
        setErrorMessage(message)
      } finally {
        setDeletingKey(null)
      }
    },
    [onDelete, deletingKey]
  )

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={isLoading || isFetching}>
      <header className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-sm font-medium text-muted-foreground">历史</h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {info ? <span>{info}</span> : null}
            {isError ? (
              <button className="text-primary" onClick={() => onRetry?.()}>
                重试
              </button>
            ) : null}
          </div>
        </div>
        {errorMessage ? (
          <p className="mt-2 text-xs text-destructive/80">{errorMessage}</p>
        ) : null}
      </header>
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <LoadingPlaceholder count={4} className="px-4" />
        ) : empty ? (
          <EmptyState title="暂无历史" description="开始新的对话以便回溯" />
        ) : (
          <ul className="flex flex-col">
            {(() => {
              const out: JSX.Element[] = []
              let lastDayKey: string | null = null
              nodes.forEach(({ item, depth, lineageDepth }, idx) => {
                const k = item.conversationId ?? item.path
                if (!k) return
                const dateKey = formatDateDay(item.timestamp || item.createdAt || null)
                if (dateKey && dateKey !== lastDayKey) {
                  lastDayKey = dateKey
                  out.push(
                    <li
                      key={`date-${dateKey}-${idx}`}
                      className={cn(
                        'sticky top-0 z-10 border-b border-border/60 px-4 py-1 text-xs font-medium',
                        'bg-muted/80 text-muted-foreground backdrop-blur-sm'
                      )}
                    >
                      {dateKey}
                    </li>
                  )
                }
                const isActive = k === activeConversationId
                const isPending = k === pendingConversationId
                const isDeleting = k === deletingKey
                const isInProgress = inProgressConversationId === k
                const paddingLeft = 16 + depth * INDENT_STEP
                const lineageTip =
                  typeof lineageDepth === 'number' && lineageDepth > depth
                    ? `原始层级 ${lineageDepth}`
                    : undefined
                out.push(
                  <li key={k} className="group relative">
                    <button
                      className={cn(
                        'relative flex w-full flex-col gap-1 py-3 pr-4 md:pr-6 text-left text-sm',
                        'transition-[color] duration-200 ease-in-out',
                        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'
                      )}
                      style={{ paddingLeft }}
                      disabled={isPending || isDeleting}
                      onClick={() => onSelect?.(item)}
                      title={lineageTip}
                    >
                      {/* 右侧渐变遮罩：仅在 hover/focus 时出现，避免文字干扰删除按钮视觉 */}
                      <span
                        aria-hidden
                        className={cn(
                          'pointer-events-none absolute right-0 top-0 h-full w-14',
                          'bg-gradient-to-l from-background to-transparent',
                          'opacity-0 transition-opacity duration-200 ease-in-out',
                          'group-hover:opacity-100 group-focus-within:opacity-100',
                          'z-10'
                        )}
                      />
                      {depth > 0 ? (
                        <span
                          className="pointer-events-none absolute left-3 top-0 h-full border-l border-border/60"
                          style={{ left: `${Math.max(6, depth * INDENT_STEP - 8)}px` }}
                        />
                      ) : null}
                      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
                        {depth > 0 ? <span className="text-muted-foreground">↳</span> : null}
                        {item.model ? <span>{item.model}</span> : null}
                        {item.parentId && depth > 0 ? (
                          <span className="text-[10px] uppercase">branch</span>
                        ) : null}
                      </div>
                      <div className="line-clamp-3 text-sm text-foreground">
                        {item.preview || '（无预览）'}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground/70">
                        <span>{formatDateTime(item.timestamp || item.createdAt || null)}</span>
                        {typeof item.turns === 'number' ? (
                          <span className="ml-auto tabular-nums">
                            {item.turns === 1 ? '1 turn' : `${item.turns} turns`}
                          </span>
                        ) : null}
                      </div>
                      {isInProgress ? (
                        <Loader2 className="absolute right-4 top-1/2 z-20 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                    {onDelete ? (
                      <AlertDialog
                        onOpenChange={async (open) => {
                          if (!open) {
                            setVibeCheck({ key: null, loading: false, associated: false })
                            return
                          }
                          const key = item.conversationId ?? item.path
                          if (!key) return
                          setVibeCheck({ key, loading: true, associated: false })
                          try {
                            const res = await chatApi.checkVibeLink({
                              conversationId: item.conversationId ?? null,
                              path: item.path ?? null
                            })
                            setVibeCheck({
                              key,
                              loading: false,
                              associated: Boolean(res?.associated),
                              projectId: res?.projectId,
                              taskId: res?.taskId,
                              projectName: res?.projectName,
                              taskTitle: res?.taskTitle
                            })
                          } catch (e) {
                            // 静默失败，不阻塞删除
                            setVibeCheck({ key, loading: false, associated: false })
                          }
                        }}
                      >
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className={cn(
                              'absolute right-2 top-1/2 -translate-y-1/2 z-20',
                              'text-muted-foreground/60',
                              'transition-opacity transition-colors duration-200 ease-in-out',
                              'hover:text-destructive',
                              'focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0 focus-visible:border-transparent',
                              'opacity-0 pointer-events-none group-hover:opacity-100 group-focus-within:opacity-100 group-hover:pointer-events-auto group-focus-within:pointer-events-auto'
                            )}
                            tabIndex={-1}
                            onMouseDown={(e) => {
                              // 阻止默认的 focus 行为，避免按钮获得焦点
                              e.preventDefault()
                            }}
                            onClick={(event) => {
                              // Shift + 点击：跳过二次确认，直接删除
                              if (event.shiftKey) {
                                event.preventDefault()
                                event.stopPropagation()
                                handleDelete(item, { skipConfirm: true })
                                return
                              }
                              // 常规点击：走 AlertDialog 确认
                              event.stopPropagation()
                            }}
                            aria-label="删除会话"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent onClick={(event) => event.stopPropagation()}>
                          <AlertDialogHeader>
                            <AlertDialogTitle>确认删除会话？</AlertDialogTitle>
                            <AlertDialogDescription>
                              删除 {item.preview || item.path} 后无法恢复。按住 Shift 再点击“删除”可跳过确认。
                            </AlertDialogDescription>
                            {(() => {
                              const key = item.conversationId ?? item.path
                              if (!key) return null
                              if (vibeCheck.key !== key) return null
                              if (vibeCheck.loading) {
                                return (
                                  <p className="text-xs text-muted-foreground">正在检查是否关联 vibe-kanban 任务…</p>
                                )
                              }
                              if (vibeCheck.associated && vibeCheck.projectId && vibeCheck.taskId) {
                                const href = `/projects/${vibeCheck.projectId}/tasks/${vibeCheck.taskId}`
                                return (
                                  <div className="rounded border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
                                    <p className="font-medium">警告：此会话关联了 vibe-kanban 任务</p>
                                    <p className="mt-1 break-all">
                                      项目 ID：{vibeCheck.projectId}
                                      {vibeCheck.projectName ? `（${vibeCheck.projectName}）` : null}
                                    </p>
                                    <p className="break-all">
                                      任务 ID：{vibeCheck.taskId}
                                      {vibeCheck.taskTitle ? `（${vibeCheck.taskTitle}）` : null}
                                    </p>
                                    <p className="mt-1 break-all">路径：{href}</p>
                                  </div>
                                )
                              }
                              return null
                            })()}
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
                            <AlertDialogAction
                              autoFocus
                              disabled={isDeleting}
                              onClick={(event) => {
                                event.stopPropagation()
                                handleDelete(item)
                              }}
                            >
                              删除
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </li>
                )
              })
              return out
            })()}
            {hasNextPage ? (
              <li key="history-load-more" className="px-4 py-2 text-sm text-muted-foreground">
                <div ref={loadMoreRef} className="h-1" />
                <button
                  className="text-sm text-primary"
                  disabled={isFetchingNextPage}
                  onClick={() => onLoadMore?.()}
                >
                  {isFetchingNextPage ? '加载中…' : '加载更多'}
                </button>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </div>
  )
}

HistoryList.displayName = 'HistoryList'
