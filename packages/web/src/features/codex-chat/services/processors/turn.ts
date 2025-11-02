import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { ws } from '@/lib/ws/singleton'

function parseTs(s?: string): number {
  try {
    return s ? new Date(s).getTime() : NaN
  } catch {
    return NaN
  }
}

export function handleTurn(method: string, params: any) {
  switch (method) {
    case 'chat.turn.started': {
      const startedAt =
        typeof params?.startedAt === 'string'
          ? params.startedAt
          : typeof params?.ts === 'string'
            ? params.ts
            : undefined
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store ? chatTurnSelectors.currentSlice(store) : undefined
        const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        const hasActive = !!slice?.activeTurnId
        const hasStreaming = turns.some((t: any) => t?.status === 'streaming')
        const last = turns.length > 0 ? turns[turns.length - 1] : undefined

        // 已有活跃/streaming → 仅补 startedAt
        if (hasActive || hasStreaming) {
          chatTurnActions.markTurnStarted({ startedAt })
          return true
        }

        // 无任何 turn → 开启一轮
        if (!last) {
          chatTurnActions.markTurnStarted({ startedAt })
          return true
        }

        // 存在已完成上一轮：若 started 落在上一轮结束边界之前，认为是“迟到信号”并忽略
        const tStarted = parseTs(startedAt)
        const tCompleted = parseTs((last as any)?.completedAt)
        const tAssistant = parseTs((last as any)?.assistant?.ts)
        const boundary = Math.max(
          Number.isFinite(tCompleted) ? tCompleted : 0,
          Number.isFinite(tAssistant) ? tAssistant : 0
        )
        if (Number.isFinite(tStarted) && boundary > 0 && tStarted <= boundary) {
          return true
        }

        // 其它情况：开启新一轮
        chatTurnActions.markTurnStarted({ startedAt })
        return true
      } catch {
        // 异常时保守开启
        chatTurnActions.markTurnStarted({ startedAt })
        return true
      }
    }
    case 'chat.turn.complete': {
      const ts = typeof params?.ts === 'string' ? params.ts : undefined
      chatTurnActions.completeTurn(ts ? { completedAt: ts } : undefined)
      try {
        const eid = Number((params as any)?.eventId ?? 0) || 0
        const cid =
          typeof (params as any)?.conversationId === 'string'
            ? (params as any).conversationId
            : undefined
        if (cid && eid > 0) ws.primeConversationCursor(cid, eid)
      } catch {}
      return true
    }
  }
  return false
}
