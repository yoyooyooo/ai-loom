import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'
import { ws } from '@/lib/ws/singleton'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { createProcessChatEvent } from './ws-processors'
import { chatTrace } from '@/lib/logger'
import type {
  CodexAuthStatusChangePayload,
  CodexRateLimitPayload,
  CodexRuntimeEventPayload,
  CodexSessionConfiguredPayload
} from '@/lib/ws/types'
import { ensureDeltaPipelines } from './delta-streams'
import { makeSessionConfiguredHandler, handleAuthStatusChange, handleRateLimitUpdated } from './ws-capabilities'
import { normalizeCodexRuntimeEvent } from './ws-normalize'

// 使用全局 WS 单例，避免在开发模式（React StrictMode）下产生多条连接
export function subscribeChatEvents() {
  // 默认启用 RxJS 微批；在 Vitest 测试环境自动关闭以保持用例确定性
  const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
  const USE_RX_DELTA = !isVitest
  if (USE_RX_DELTA) ensureDeltaPipelines()
  const AGG = ((import.meta as any).env?.VITE_CHAT_TOOL_AGGREGATE ?? '1') !== '0'
  const KEEP_STREAM = ((import.meta as any).env?.VITE_CHAT_TOOL_KEEP_STREAM ?? '0') === '1'
  const PATCH_MAX_FILES = ((): number => {
    const v = (import.meta as any).env?.VITE_CHAT_PATCH_MAX_FILES
    return v == null ? Number.POSITIVE_INFINITY : Number(v)
  })()
  const PATCH_MAX_CHARS = ((): number => {
    const v = (import.meta as any).env?.VITE_CHAT_PATCH_MAX_CHARS
    return v == null ? Number.POSITIVE_INFINITY : Number(v)
  })()
  const processor = createProcessChatEvent({
    useRxDelta: USE_RX_DELTA,
    aggregateTools: AGG,
    keepToolStream: KEEP_STREAM,
    patchMaxFiles: PATCH_MAX_FILES,
    patchMaxChars: PATCH_MAX_CHARS
  })

  // 不再使用“前端收尾 fuse”；以明确的 completed/failed/aborted/turn.complete 为收尾依据。
  // 读取合并（Explored）命令解析见：@/features/codex-chat/utils/explore-utils

  // patch diff 渲染已迁移至 ws-processors → ws-render-utils
  const initialCid = (useChatTurnStore as any).getState?.()?.conversationId as string | undefined
  chatTrace('ws.subscribe.init', { initialCid })
  let topicSub = ws
    .subscribeTopic$('chat', initialCid ? { conversationId: initialCid } : {})
    .subscribe({})
  const unsubscribeCid = useChatTurnStore.subscribe((state: any, prev: any) => {
    const cid = state?.conversationId
    const prevCid = prev?.conversationId
    if (cid === prevCid) return
    chatTrace('ws.subscribe.conversationChanged', { prevCid, cid })
    topicSub.unsubscribe()
    topicSub = ws
      .subscribeTopic$('chat', cid ? { conversationId: cid } : {})
      .subscribe({})
  })

  const guardConversation = (method: string, eventConversationId?: string) => {
    if (
      method === 'chat.session.new' ||
      method === 'chat.session.resumed' ||
      method === 'chat.session.history'
    ) {
      if (eventConversationId) chatTurnActions.setConversationId(eventConversationId)
      return true
    }
    const currentId = (useChatTurnStore as any).getState?.()?.conversationId as string | undefined
    if (!currentId && eventConversationId) {
      chatTurnActions.setConversationId(eventConversationId)
      return true
    }
    if (eventConversationId && currentId && eventConversationId !== currentId) {
      chatTrace('ws.guard.skip', { method, eventConversationId, currentId })
      return false
    }
    return true
  }

  // base64 解码逻辑已移至 ws-normalize

  const handleSessionConfigured = makeSessionConfiguredHandler(processor)

  // 认证状态与速率限制更新的处理已抽离到 ws-capabilities

  // normalize 已抽离到 ws-normalize.ts

  function processChatEvent(method: string, params: any) {
    chatTrace('ws.process.begin', { method, conversationId: (params as any)?.conversationId, keys: params ? Object.keys(params) : [] })
    processor(method, params)
  }

  const sub = ws.events$.subscribe(({ method: rawMethod, params: rawParams }) => {
    try {
      if (typeof rawMethod !== 'string') return
      let method = rawMethod
      let params = rawParams
      chatTrace('ws.event.incoming', {
        method,
        hasConversationId: !!(rawParams as any)?.conversationId
      })

      if (method.startsWith('codex/')) {
        if (method === 'codex/sessionConfigured') {
          handleSessionConfigured(params as CodexSessionConfiguredPayload)
          return
        }
        if (method === 'codex/authStatusChange') {
          handleAuthStatusChange(params as CodexAuthStatusChangePayload)
          return
        }
        if (method === 'codex/account/rateLimits/updated') {
          handleRateLimitUpdated(params as CodexRateLimitPayload)
          return
        }
        if (method.startsWith('codex/event/')) {
          const normalized = normalizeCodexRuntimeEvent(params as CodexRuntimeEventPayload)
          if (!normalized) return
          method = normalized.method
          params = normalized.params
          chatTrace('ws.event.normalized', {
            rawMethod,
            mappedMethod: method,
            conversationId: (params as any)?.conversationId
          })
        } else {
          return
        }
      }

      if (!method.startsWith('chat.')) return
      const eventConversationId = (params as any)?.conversationId as string | undefined
      if (!guardConversation(method, eventConversationId)) return
      processChatEvent(method, params)
    } catch (error) {
      chatTrace('ws.event.error', {
        method: rawMethod,
        error: error instanceof Error ? error.message : String(error)
      })
      // eslint-disable-next-line no-console
      console.error('[chat/ws] event handler error', rawMethod, error)
    }
  })

  return () => {
    chatTrace('ws.subscribe.cleanup', {})
    sub.unsubscribe()
    topicSub.unsubscribe()
    unsubscribeCid()
  }
}
