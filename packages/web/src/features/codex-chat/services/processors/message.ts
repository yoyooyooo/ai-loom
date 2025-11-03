import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { ws } from '@/lib/ws/singleton'
import { useChatHydrationStore } from '@/features/codex-chat/stores/chat-hydration'

export function handleMessage(method: string, params: any, opts: { useRxDelta: boolean }) {
  const eventCid =
    typeof (params as any)?.conversationId === 'string' ? (params as any).conversationId : undefined
  switch (method) {
    case 'chat.message.delta': {
      if (opts.useRxDelta) return true
      const delta = params?.delta ?? ''
      if (typeof delta !== 'string' || !delta) return true
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store
          ? eventCid
            ? chatTurnSelectors.sliceById(eventCid)(store)
            : chatTurnSelectors.currentSlice(store)
          : undefined
        const hasActive = !!slice?.activeTurnId
        const turnsArr: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        const hasStreaming = turnsArr.some((t: any) => t?.status === 'streaming')
        if (!hasActive && !hasStreaming) {
          const last = turnsArr.length > 0 ? turnsArr[turnsArr.length - 1] : undefined
          // 已完成的上一轮之后到达的 delta 直接忽略，避免重复开启
          if (last && last.status === 'completed') return true
          chatTurnActions.markTurnStarted({})
        }
      } catch {
        chatTurnActions.markTurnStarted({})
      }
      chatTurnActions.markFinalMessageStarted()
      chatTurnActions.appendAssistantDelta(delta)
      return true
    }
    case 'chat.message.completed': {
      const text = typeof params?.text === 'string' ? params.text : ''
      const isCompactDone = (text || '').trim().toLowerCase() === 'compact task completed'
      if (isCompactDone) {
        // Compact 特例：只插入 info，不结束 turn、不写 assistant 文本
        chatTurnActions.unmarkFinalMessageStarted()
        chatTurnActions.addStep('info', undefined, '[Compact] 任务完成', {
          status: 'completed',
          meta: { compactDone: true }
        })
        return true
      }
      const eventId = Number((params as any)?.eventId ?? 0) || 0
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store
          ? eventCid
            ? chatTurnSelectors.sliceById(eventCid)(store)
            : chatTurnSelectors.currentSlice(store)
          : undefined
        const hasActive = !!slice?.activeTurnId
        const turns = Array.isArray(slice?.turns) ? slice.turns : []
        const hasStreaming = turns.some((t: any) => t?.status === 'streaming')
        if (!hasActive && !hasStreaming) {
          // 握手期补发：若最后一轮已完成且已有助手正文，直接忽略，避免重复气泡
          try {
            const cid =
              typeof (params as any)?.conversationId === 'string'
                ? (params as any).conversationId
                : undefined
            if (cid) {
              const hyd = (useChatHydrationStore as any)?.getState?.()
              const hydrating = !!hyd?.hydrating?.[cid]
              if (hydrating) {
                const last = turns.length > 0 ? turns[turns.length - 1] : undefined
                const lastCompletedWithAssistant =
                  !!last &&
                  last.status === 'completed' &&
                  String(last?.assistant?.text || '').trim()
                if (lastCompletedWithAssistant) return true
              }
            }
          } catch {}
          const last = turns.length > 0 ? turns[turns.length - 1] : undefined
          const lastAssistant = (last?.assistant?.text || '').trim()
          const incoming = (text || '').trim()
          const isDupAssistant =
            !!last &&
            last.status === 'completed' &&
            (!!incoming ? lastAssistant === incoming : lastAssistant.length > 0)
          if (!isDupAssistant) chatTurnActions.markTurnStarted({})
          else return true
        }
      } catch {
        chatTurnActions.markTurnStarted({})
      }
      const ts = typeof params?.ts === 'string' ? params.ts : undefined
      chatTurnActions.completeAssistant(text, ts, eventId)
      try {
        const cid =
          typeof (params as any)?.conversationId === 'string'
            ? (params as any).conversationId
            : undefined
        if (cid && eventId > 0) ws.primeConversationCursor(cid, eventId)
      } catch {}
      chatTurnActions.completeTurn({ finalizeGenerating: false })
      return true
    }
    case 'chat.message.failed': {
      const msg = params?.error?.message || '生成失败'
      chatTurnActions.failAssistant(msg)
      try {
        const eid = Number((params as any)?.eventId ?? 0) || 0
        const cid =
          typeof (params as any)?.conversationId === 'string'
            ? (params as any).conversationId
            : undefined
        if (cid && eid > 0) ws.primeConversationCursor(cid, eid)
      } catch {}
      chatTurnActions.completeTurn({ finalizeGenerating: false })
      return true
    }
    case 'chat.message.aborted': {
      chatTurnActions.abortAssistant()
      try {
        const eid = Number((params as any)?.eventId ?? 0) || 0
        const cid =
          typeof (params as any)?.conversationId === 'string'
            ? (params as any).conversationId
            : undefined
        if (cid && eid > 0) ws.primeConversationCursor(cid, eid)
      } catch {}
      chatTurnActions.completeTurn({ finalizeGenerating: true })
      return true
    }
  }
  return false
}
