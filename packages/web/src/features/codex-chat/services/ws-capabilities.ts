import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { chatTrace } from '@/lib/logger'
import type { EventMsg } from '@/lib/codex-types/EventMsg'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'
import type {
  CodexAuthStatusChangePayload,
  CodexRateLimitPayload,
  CodexRuntimeEventPayload,
  CodexSessionConfiguredPayload
} from '@/lib/ws/types'

export function eventMsgToHistory(msg: EventMsg) {
  switch (msg.type) {
    case 'user_message':
      return { role: 'user' as const, text: msg.message ?? '', reasoning: null }
    case 'agent_message':
      return { role: 'assistant' as const, text: msg.message ?? '', reasoning: null }
    case 'agent_reasoning':
      return { role: 'reasoning' as const, text: '', reasoning: msg.text ?? '' }
    default:
      return null
  }
}

export function makeSessionConfiguredHandler(
  processor: (method: string, params: any) => void
) {
  return function handleSessionConfigured(payload: CodexSessionConfiguredPayload) {
    chatTrace('ws.sessionConfigured', {
      conversationId: payload?.conversationId,
      model: payload?.model,
      initialCount: Array.isArray(payload?.initialMessages) ? payload.initialMessages.length : 0
    })

    const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
    if (conversationId) {
      chatTurnActions.setConversationId(conversationId)
      processor('chat.session.resumed', { conversationId })
      try {
        const st: any = (useChatTurnStore as any).getState?.()
        const hasExisting = Array.isArray(st?.turns) && st.turns.length > 0
        if (!hasExisting) {
          const history = Array.isArray(payload?.initialMessages)
            ? payload.initialMessages
                .map((msg) => eventMsgToHistory(msg))
                .filter((item): item is NonNullable<ReturnType<typeof eventMsgToHistory>> => !!item)
            : []
          if (history.length > 0) {
            processor('chat.session.history', { conversationId, messages: history })
          }
        } else {
          chatTrace('ws.sessionConfigured.skipInitial', { reason: 'turns-not-empty' })
        }
      } catch {}
    }

    // provider 能力与模型列表补丁
    const models = Array.isArray(payload?.models) ? payload.models : []
    const mappedModels = models.map((item: any) => ({
      id: String(item?.id ?? item?.model ?? ''),
      model: String(item?.model ?? item?.id ?? ''),
      displayName: String(item?.displayName ?? item?.model ?? ''),
      description: item?.description ?? undefined,
      isDefault: !!item?.isDefault,
      defaultReasoningEffort: item?.defaultReasoningEffort ?? null,
      supportedReasoningEfforts: item?.supportedReasoningEfforts ?? []
    }))
    codexChatProviderActions.setModels(conversationId ?? undefined, mappedModels)

    const model = typeof payload?.model === 'string' ? payload.model : undefined
    const patch = {
      providerId: 'codex' as const,
      model,
      extra: { sessionConfigured: payload }
    }
    codexChatProviderActions.setCapabilities(undefined, patch)
    if (conversationId) codexChatProviderActions.setCapabilities(conversationId, patch)
  }
}

export function handleAuthStatusChange(payload: CodexAuthStatusChangePayload) {
  const authenticated = !!payload?.authenticated
  const capabilities = {
    providerId: 'codex' as const,
    authenticated
  }
  codexChatProviderActions.setCapabilities(undefined, capabilities)
  if (payload?.conversationId) codexChatProviderActions.setCapabilities(payload.conversationId, capabilities)
}

export function handleRateLimitUpdated(payload: CodexRateLimitPayload) {
  const snapshot = payload?.rateLimits ?? null
  const primary = snapshot?.primary ?? null
  const remaining = typeof primary?.used_percent === 'number' ? Math.max(0, 100 - primary.used_percent) : undefined
  let resetAt: string | undefined
  if (typeof primary?.resets_in_seconds === 'number') {
    resetAt = new Date(Date.now() + primary.resets_in_seconds * 1000).toISOString()
  }
  const patch = {
    providerId: 'codex' as const,
    rateLimits: remaining == null && resetAt == null ? undefined : { remaining, resetAt },
    extra: { rateLimitsSnapshot: snapshot }
  }
  codexChatProviderActions.setCapabilities(undefined, patch)
  if (payload?.conversationId) codexChatProviderActions.setCapabilities(payload.conversationId, patch)
}
