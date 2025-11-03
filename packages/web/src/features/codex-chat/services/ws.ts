import { EMPTY, defer, of } from 'rxjs'
import { finalize, mergeMap, share, tap, filter } from 'rxjs/operators'

import { chatTurnActions } from '../stores/chat-turns'
import { ws } from '@/lib/ws/singleton'
import { createProcessChatEvent } from './processors'
import { chatTrace } from '@/lib/logger'
import type {
  CodexAuthStatusChangePayload,
  CodexRateLimitPayload,
  CodexSessionConfiguredPayload
} from '@/lib/ws/types'
import { startDeltaPipelines } from './delta-streams'
import { buildChatPipeline } from './ws-pipeline'
import { buildCodexPipeline } from './ws-pipeline-codex'
import { useChatHydrationStore } from '../stores/chat-hydration'
import {
  initGlobalGeneratingAggregator,
  seedGenerating
} from './generating-aggregator'
import { chatApi } from './api'
import {
  makeSessionConfiguredHandler,
  handleAuthStatusChange,
  handleRateLimitUpdated
} from './ws-capabilities'
import { createWsEventHub, createHydrationEffects$, HydrationEffect } from './ws-streams'
import {
  readEnvValue,
  parseBoolean,
  parseNumber,
  parsePositiveNumber,
  parseNonNegativeNumber
} from '@/lib/env/parsers'
import { getConversationId, eventIdFromParams } from '@/lib/ws/chat-utils'

type ChatRuntimeConfig = {
  isVitest: boolean
  useRxDelta: boolean
  aggregateTools: boolean
  keepToolStream: boolean
  patchMaxFiles: number
  patchMaxChars: number
  handshakeBuffer: boolean
  handshakeStrict: boolean
  handshakeMinMs: number
  genAggMode: string
  deltaBatchMs: number
}

const resolveChatRuntimeConfig = (): ChatRuntimeConfig => {
  const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
  const aggregateTools = parseBoolean(readEnvValue('VITE_CHAT_TOOL_AGGREGATE'), true)
  const keepToolStream = parseBoolean(readEnvValue('VITE_CHAT_TOOL_KEEP_STREAM'), false)
  const patchMaxFilesRaw = readEnvValue('VITE_CHAT_PATCH_MAX_FILES')
  const patchMaxCharsRaw = readEnvValue('VITE_CHAT_PATCH_MAX_CHARS')
  const handshakeBuffer = parseBoolean(readEnvValue('VITE_CHAT_HANDSHAKE_BUFFER'), true)
  const handshakeStrict = parseBoolean(readEnvValue('VITE_CHAT_HANDSHAKE_STRICT'), false)
  const handshakeMinMs = parseNonNegativeNumber(readEnvValue('VITE_CHAT_HANDSHAKE_MIN_MS'), 200)
  const genAggMode = String(readEnvValue('VITE_CHAT_GEN_AGG_MODE') ?? 'global')
  const deltaBatchMs = parsePositiveNumber(readEnvValue('VITE_CHAT_BATCH_MS'), 16)

  return {
    isVitest,
    useRxDelta: !isVitest,
    aggregateTools,
    keepToolStream,
    patchMaxFiles:
      patchMaxFilesRaw == null
        ? Number.POSITIVE_INFINITY
        : parseNumber(patchMaxFilesRaw, Number.POSITIVE_INFINITY),
    patchMaxChars:
      patchMaxCharsRaw == null
        ? Number.POSITIVE_INFINITY
        : parseNumber(patchMaxCharsRaw, Number.POSITIVE_INFINITY),
    handshakeBuffer,
    handshakeStrict,
    handshakeMinMs,
    genAggMode,
    deltaBatchMs
  }
}

const lastEventIdByConversation = new Map<string, number>()

const handleHydrationEffect = (effect: HydrationEffect) => {
  try {
    if (effect.kind === 'set') {
      useChatHydrationStore.getState().setHydrating(effect.cid, true)
      return
    }
    if (effect.kind === 'clear') {
      useChatHydrationStore.getState().setHydrating(effect.cid, false)
      return
    }
    if (effect.kind === 'prime' && effect.upto > 0) {
      const prev = lastEventIdByConversation.get(effect.cid) ?? 0
      if (effect.upto > prev) {
        lastEventIdByConversation.set(effect.cid, effect.upto)
      }
      const prime = (ws as any)?.primeConversationCursor
      if (typeof prime === 'function') prime.call(ws, effect.cid, effect.upto)
    }
  } catch {}
}

// 使用全局 WS 单例，避免在开发模式（React StrictMode）下产生多条连接
export function subscribeChatEvents() {
  const config = resolveChatRuntimeConfig()

  const processor = createProcessChatEvent({
    useRxDelta: config.useRxDelta,
    aggregateTools: config.aggregateTools,
    keepToolStream: config.keepToolStream,
    patchMaxFiles: config.patchMaxFiles,
    patchMaxChars: config.patchMaxChars
  })

  // 不再使用“前端收尾 fuse”；以明确的 completed/failed/aborted/turn.complete 为收尾依据。
  // 读取合并（Explored）命令解析见：@/features/codex-chat/utils/explore-utils

  chatTrace('ws.subscribe.init', {
    useRxDelta: config.useRxDelta,
    handshakeBuffer: config.handshakeBuffer,
    handshakeStrict: config.handshakeStrict
  })

  const hub = createWsEventHub(ws.events$)

  const handleSessionConfigured = makeSessionConfiguredHandler(processor)

  const deltaSub = config.useRxDelta
    ? startDeltaPipelines(hub.source$, {
        batchMs: config.deltaBatchMs,
        isVitest: config.isVitest
      })
    : null

  const { chat$: pipelineChat$ } = buildChatPipeline(
    {
      chat$: hub.chat$,
      syncBegin$: hub.syncBegin$,
      syncEnd$: hub.syncEnd$
    },
    {
      enableBuffer: config.handshakeBuffer,
      strictBuffer: config.handshakeStrict
    }
  )

  const hydratedChat$ = pipelineChat$.pipe(share())

  const dedupedChat$ = hydratedChat$
    .pipe(
      filter((event) => {
        const cid = getConversationId(event.params)
        if (!cid) return true
        const eventId = eventIdFromParams(event.params)
        if (eventId <= 0) return true
        const prev = lastEventIdByConversation.get(cid) ?? 0
        if (eventId <= prev) return false
        lastEventIdByConversation.set(cid, eventId)
        return true
      }),
      share()
    )

  const processedChat$ = dedupedChat$
    .pipe(
      mergeMap((event) =>
        defer(() => {
          const { method, params } = event
          const cid = (params as any)?.conversationId
          chatTurnActions.__beginFor(cid)
          return of(event).pipe(
            tap(() => processor(method, params)),
            finalize(() => chatTurnActions.__endEvent())
          )
        })
      ),
      share()
    )

  const hydrationSub = createHydrationEffects$({
    syncBegin$: hub.syncBegin$,
    syncEnd$: hub.syncEnd$,
    chat$: processedChat$,
    minHoldMs: config.handshakeMinMs
  }).subscribe(handleHydrationEffect)

  const codexHandlers: Record<string, (payload: any) => void> = {
    'codex/sessionConfigured': (payload) =>
      handleSessionConfigured(payload as CodexSessionConfiguredPayload),
    'codex/authStatusChange': (payload) =>
      handleAuthStatusChange(payload as CodexAuthStatusChangePayload),
    'codex/account/rateLimits/updated': (payload) =>
      handleRateLimitUpdated(payload as CodexRateLimitPayload)
  }

  const codexSub = hub.codex$
    .pipe(
      mergeMap((event) => {
        const handler = codexHandlers[event.method]
        if (!handler) return EMPTY
        return defer(() => {
          handler(event.params)
          return of(null)
        })
      })
    )
    .subscribe()

  const chatSub = processedChat$.subscribe()

  // 全局“进行中”聚合（默认开启；可用 VITE_CHAT_GEN_AGG_MODE=off 关闭）
  let stopGenAgg: (() => void) | null = null
  if (config.genAggMode !== 'off') {
    try {
      stopGenAgg = initGlobalGeneratingAggregator()
      if (!config.isVitest) {
        chatApi
          .runtimeSnapshots({ provider: 'codex' })
          .then((res) => {
            const items = Array.isArray((res as any)?.items) ? (res as any).items : []
            for (const it of items) {
              const cid = (it as any)?.conversationId
              if (!cid) continue
              const provider = (it as any)?.provider || (it as any)?.providerId || ''
              const key = provider ? `${provider}|${cid}` : cid
              seedGenerating(key, !!(it as any)?.generating)
            }
          })
          .catch(() => {})
      }
    } catch {}
  }

  return () => {
    chatTrace('ws.subscribe.cleanup', {})
    hydrationSub.unsubscribe()
    codexSub.unsubscribe()
    chatSub.unsubscribe()
    deltaSub?.unsubscribe()
    lastEventIdByConversation.clear()
    if (stopGenAgg) {
      try {
        stopGenAgg()
      } catch {}
    }
  }
}
