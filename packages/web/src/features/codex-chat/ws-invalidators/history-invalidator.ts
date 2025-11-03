import type { QueryClient } from '@tanstack/react-query'
import { useSubscription } from 'observable-hooks'
import { ws } from '@/lib/ws/singleton'

export type ChatHistoryInvalidatorOptions = {
  onOptimisticFailure?: (conversationId: string) => void
}

/**
 * React Hook：基于 observable-hooks 订阅 chat.* 事件，失效聊天历史查询
 */
export function useChatHistoryInvalidator(
  qc: QueryClient,
  options: ChatHistoryInvalidatorOptions = {}
) {
  useSubscription(ws.events$, ({ method, params }) => {
    if (typeof method !== 'string') return
    // 粗粒度自愈：收到 session.resync 时，强制刷新历史
    if (method === 'session.resync') {
      qc.invalidateQueries({ queryKey: ['chat', 'history'] })
      return
    }
    if (!method.startsWith('chat.')) return
    const conversationId = (params as any)?.conversationId as string | undefined
    switch (method) {
      case 'chat.session.new':
      case 'chat.session.history':
      case 'chat.info.conversation_path':
      case 'chat.message.completed':
      case 'chat.turn.complete': {
        qc.invalidateQueries({ queryKey: ['chat', 'history'] })
        break
      }
      case 'chat.message.failed':
      case 'chat.message.aborted': {
        // 事件侧异常处理：若是新会话首轮失败/中止，移除同 conversationId 的乐观占位
        if (conversationId) {
          options.onOptimisticFailure?.(conversationId)
          qc.setQueryData(['chat', 'history', { pageSize: 20 }], (prev: any) => {
            if (!prev || !Array.isArray(prev.pages)) return prev
            const pages = prev.pages.map((pg: any) => ({
              ...pg,
              items: (pg.items || []).filter(
                (it: any) => !(it?.conversationId === conversationId && it?.__optimistic === true)
              )
            }))
            return { ...prev, pages }
          })
        }
        qc.invalidateQueries({ queryKey: ['chat', 'history'] })
        break
      }
      default:
        break
    }
  })
}
