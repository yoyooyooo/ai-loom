import { chatTurnActions } from '../stores/chat-turns'
import { ws } from '@/lib/ws/singleton'
import { createProcessChatEvent } from './processors'
import { chatTrace } from '@/lib/logger'
import type {
  CodexAuthStatusChangePayload,
  CodexRateLimitPayload,
  CodexSessionConfiguredPayload
} from '@/lib/ws/types'
import { ensureDeltaPipelines } from './delta-streams'
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
import { filter } from 'rxjs/operators'

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

  chatTrace('ws.subscribe.init', {})

  const handleSessionConfigured = makeSessionConfiguredHandler(processor)

  // 认证状态与速率限制更新的处理已抽离到 ws-capabilities

  // Codex runtime 事件已经在服务端归一化为 chat.*

  // 握手期缓冲逻辑位于 RxJS 管道（buildChatPipeline）

  // 先构建 chat.* 管道（含握手期缓冲）
  const { chat$: hydratedChat$, syncEnd$ } = buildChatPipeline(ws.events$, {
    enableBuffer: ((import.meta as any).env?.VITE_CHAT_HANDSHAKE_BUFFER ?? '1') !== '0',
    strictBuffer: ((import.meta as any).env?.VITE_CHAT_HANDSHAKE_STRICT ?? '0') === '1'
  })

  // 同步 end：推进“已应用游标”
  const endSub = syncEnd$.subscribe(({ params }) => {
    try {
      const cid = (params as any)?.conversationId as string | undefined
      const upto = Number((params as any)?.uptoEventId ?? 0) || 0
      if (cid) {
        // 保持最小展示时间，避免闪烁
        const MIN_HOLD = Number((import.meta as any).env?.VITE_CHAT_HANDSHAKE_MIN_MS ?? 200)
        const startedAt = hydratingStartedAt.get(cid) || 0
        const elapsed = startedAt ? Date.now() - startedAt : MIN_HOLD
        const clear = () => useChatHydrationStore.getState().setHydrating(cid, false)
        if (elapsed < MIN_HOLD) {
          const t = setTimeout(clear, MIN_HOLD - elapsed)
          holdTimers.add(t)
        } else {
          clear()
        }
      }
      if (cid && upto > 0) ws.primeConversationCursor(cid, upto)
    } catch {}
  })

  // 同步 begin：仅用于 UI 指示，不落地到 store
  const hydratingStartedAt = new Map<string, number>()
  const holdTimers = new Set<any>()
  const beginSub = ws.events$
    .pipe(filter((ev) => ev.method === 'chat.session.sync_begin'))
    .subscribe(({ params }) => {
      try {
        const cid = (params as any)?.conversationId as string | undefined
        if (cid) {
          hydratingStartedAt.set(cid, Date.now())
          useChatHydrationStore.getState().setHydrating(cid, true)
        }
      } catch {}
    })

  // codex/* 管道（会话配置/认证/限额）
  const { sessionConfigured$, authStatusChange$, rateLimitUpdated$ } = buildCodexPipeline(
    ws.events$
  )
  const codexSub1 = sessionConfigured$.subscribe((p) =>
    handleSessionConfigured(p as CodexSessionConfiguredPayload)
  )
  const codexSub2 = authStatusChange$.subscribe((p) =>
    handleAuthStatusChange(p as CodexAuthStatusChangePayload)
  )
  const codexSub3 = rateLimitUpdated$.subscribe((p) =>
    handleRateLimitUpdated(p as CodexRateLimitPayload)
  )

  // chat.* 事件：经由握手缓冲后的稳定流
  const chatSub = hydratedChat$.subscribe(({ method, params }) => {
    try {
      chatTurnActions.__beginFor((params as any)?.conversationId)
      processor(method, params)
    } finally {
      chatTurnActions.__endEvent()
    }
  })

  // 全局“进行中”聚合（默认开启；可用 VITE_CHAT_GEN_AGG_MODE=off 关闭）
  const GEN_MODE = ((import.meta as any).env?.VITE_CHAT_GEN_AGG_MODE ?? 'global') as string
  let stopGenAgg: (() => void) | null = null
  if (GEN_MODE !== 'off') {
    try {
      stopGenAgg = initGlobalGeneratingAggregator()
      // 初始种子：使用 runtime 快照（非 Vitest 环境）
      const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
      if (!isVitest) {
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
    beginSub.unsubscribe()
    endSub.unsubscribe()
    codexSub1.unsubscribe()
    codexSub2.unsubscribe()
    codexSub3.unsubscribe()
    chatSub.unsubscribe()
    if (stopGenAgg) {
      try {
        stopGenAgg()
      } catch {}
    }
    // 清理可能遗留的 hold 定时器
    try {
      holdTimers.forEach((t) => clearTimeout(t))
      holdTimers.clear()
    } catch {}
  }
}
