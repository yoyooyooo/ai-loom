import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { stripDuplicatedTitle } from '@/features/codex-chat/stores/chat-turns-utils'

export function handleReasoning(method: string, params: any, opts: { useRxDelta: boolean }) {
  const eventCid =
    typeof (params as any)?.conversationId === 'string' ? (params as any).conversationId : undefined
  switch (method) {
    case 'chat.reasoning.delta': {
      if (opts.useRxDelta) return true
      const delta = typeof params?.delta === 'string' ? params.delta : ''
      if (delta) {
        const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
        const source = typeof params?.source === 'string' ? params.source : 'content'
        chatTurnActions.appendReasoning(delta, {
          itemId,
          source: source === 'raw' ? 'raw' : 'content'
        })
      }
      return true
    }
    case 'chat.reasoning.raw_delta': {
      if (opts.useRxDelta) return true
      const delta = typeof params?.delta === 'string' ? params.delta : ''
      if (delta) {
        const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
        chatTurnActions.appendReasoning(delta, { itemId, source: 'raw' })
      }
      return true
    }
    case 'chat.reasoning.item_started': {
      if (opts.useRxDelta) return true
      const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
      if (itemId) chatTurnActions.markReasoningItemStarted(itemId)
      return true
    }
    case 'chat.reasoning.item_completed': {
      if (opts.useRxDelta) return true
      const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
      if (itemId) {
        const summary = typeof params?.text === 'string' ? params.text : undefined
        const rawContent =
          typeof params?.rawContent === 'string' ? params.rawContent : undefined
        chatTurnActions.markReasoningItemCompleted(itemId, {
          summary,
          rawContent: rawContent ?? null
        })
      }
      return true
    }
    case 'chat.reasoning.end': {
      const text = typeof params?.text === 'string' ? params.text : ''
      const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
      const rawContent =
        typeof params?.rawContent === 'string' ? params.rawContent : undefined
      chatTurnActions.endReasoning(text, { itemId, rawContent })
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store
          ? eventCid
            ? chatTurnSelectors.sliceById(eventCid)(store)
            : chatTurnSelectors.currentSlice(store)
          : undefined
        const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        const active = turns[turns.length - 1]
        const first =
          String(text || '')
            .replace(/\r/g, '')
            .split(/\n/)
            .find((ln) => ln.trim().length > 0) || ''
        const cleaned = first
          .replace(/^[\s#>*_`]+/, '')
          .replace(/[\s#*_`]+$/, '')
          .trim()
        const titleOnly = cleaned || ''
        const normalizedBody = stripDuplicatedTitle(text, titleOnly)
        const dup = !!active?.steps?.some(
          (s: any) => s?.kind === 'thinking' && String(s?.body || '') === normalizedBody
        )
        if (!dup && text) {
          const title = titleOnly ? `thinking: ${titleOnly}` : 'thinking'
          chatTurnActions.addStep('thinking', undefined, title, {
            status: 'completed',
            body: normalizedBody,
            meta: { thinking: true }
          })
        }
      } catch {}
      return true
    }
    case 'chat.reasoning.section_break': {
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store ? chatTurnSelectors.currentSlice(store) : undefined
        const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        const active = turns[turns.length - 1]
        const content = String(active?.reasoning?.content || '')
        const itemId = typeof params?.itemId === 'string' ? params.itemId : undefined
        if (content.trim().length > 0)
          chatTurnActions.appendReasoning('\n---\n', { itemId })
      } catch {}
      return true
    }
  }
  return false
}
