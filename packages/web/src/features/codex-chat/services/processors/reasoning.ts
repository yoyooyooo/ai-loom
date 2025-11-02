import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { stripDuplicatedTitle } from '@/features/codex-chat/stores/chat-turns-utils'

export function handleReasoning(method: string, params: any, opts: { useRxDelta: boolean }) {
  const eventCid =
    typeof (params as any)?.conversationId === 'string' ? (params as any).conversationId : undefined
  switch (method) {
    case 'chat.reasoning.delta': {
      if (opts.useRxDelta) return true
      const delta = typeof params?.delta === 'string' ? params.delta : ''
      if (delta) chatTurnActions.appendReasoning(delta)
      return true
    }
    case 'chat.reasoning.end': {
      const text = typeof params?.text === 'string' ? params.text : ''
      chatTurnActions.endReasoning(text)
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
        if (content.trim().length > 0) chatTurnActions.appendReasoning('\n---\n')
      } catch {}
      return true
    }
  }
  return false
}
