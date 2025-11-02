import type { Subscription } from 'rxjs'
import { ws } from '@/lib/ws/singleton'
import { chatTrace } from '@/lib/logger'
import { chatApi } from '@/features/codex-chat/services/api'
import { chatTurnActions } from '@/features/codex-chat/stores/chat-turns'
import {
  deriveResumeCapabilities,
  deriveResumeOverrides
} from '@/features/codex-chat/utils/resume-config'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'
import { useChatTurnStore, chatTurnSelectors } from '@/features/codex-chat/stores/chat-turns'
import { useChatHydrationStore } from '@/features/codex-chat/stores/chat-hydration'

const baselineApplied = new Set<string>()
// 本页面会话生命周期内“新建的会话”，用于跳过首轮 HTTP baseline（完全依赖流），对齐 vibe-kanban
const newlyCreated = new Set<string>()

export function markConversationNew(id: string) {
  if (id) newlyCreated.add(id)
}

function applyResumeConfig(conversationId: string, config: any) {
  if (!config) return
  const overridePatch = deriveResumeOverrides(config)
  if (Object.keys(overridePatch).length > 0) {
    codexChatProviderActions.setOverrides(undefined, overridePatch)
    codexChatProviderActions.setOverrides(conversationId, overridePatch)
  }
  const capabilityPatch = deriveResumeCapabilities(config)
  if (Object.keys(capabilityPatch).length > 0) {
    codexChatProviderActions.setCapabilities(undefined, capabilityPatch)
    codexChatProviderActions.setCapabilities(conversationId, capabilityPatch)
  }
}

async function applyBaseline(conversationId: string) {
  if (baselineApplied.has(conversationId)) return
  // 新建会话：跳过 HTTP baseline，完全依赖 WS 流首帧与 resumeChat 补偿
  if (newlyCreated.has(conversationId)) {
    baselineApplied.add(conversationId)
    return
  }
  try {
    const res = await chatApi.resumeByConversationId(conversationId)
    if (!res) return
    const serverTurns = Array.isArray((res as any).turns) ? ((res as any).turns as any[]) : []
    const fallbackTurns = (() => {
      const history = Array.isArray((res as any)?.history) ? ((res as any).history as any[]) : []
      if (history.length === 0) return []
      const out: any[] = []
      let seq = 0
      let current: any | null = null
      const ensureCurrent = () => {
        if (current) return current
        seq += 1
        current = {
          id: `turn-fallback_${seq}`,
          seq,
          conversationId,
          status: 'streaming',
          user: { text: '' },
          assistant: { text: '' },
          reasoning: undefined,
          steps: []
        }
        out.push(current)
        return current
      }
      for (const entry of history) {
        if (!entry || typeof entry !== 'object') continue
        const role = entry.role
        if (role === 'user') {
          seq += 1
          current = {
            id: `turn-fallback_${seq}`,
            seq,
            conversationId,
            status: 'streaming',
            user: { text: entry.text ?? '' },
            assistant: { text: '' },
            reasoning: undefined,
            steps: []
          }
          out.push(current)
        } else if (role === 'reasoning') {
          const turn = current ?? ensureCurrent()
          const content = entry.reasoning ?? entry.text ?? ''
          if (!content) continue
          const title = content.split('\n').find((line: string) => line.trim().length > 0)?.trim()
          turn.reasoning = {
            content,
            title: title || undefined
          }
        } else if (role === 'assistant') {
          const turn = current ?? ensureCurrent()
          turn.assistant = { text: entry.text ?? '' }
          if (turn.status !== 'failed' && turn.status !== 'aborted') {
            turn.status = 'completed'
          }
        }
      }
      return out.filter((t) => typeof t?.user?.text === 'string' || typeof t?.assistant?.text === 'string')
    })()

    chatTurnActions.__beginFor(conversationId)
    try {
      if (serverTurns.length > 0) {
        chatTurnActions.loadServerTurns(serverTurns as any)
      } else if (fallbackTurns.length > 0) {
        chatTurnActions.loadServerTurns(fallbackTurns as any)
      }
    } finally {
      chatTurnActions.__endEvent()
    }

    // 优先使用后端提供的 uptoEventId（HTTP resume 不再返回 events/history）。
    const uptoEventId = (() => {
      try {
        const v = (res as any)?.uptoEventId
        if (typeof v === 'number') return v
        if (v != null) {
          const n = Number(v)
          return Number.isFinite(n) ? n : 0
        }
      } catch {}
      return 0
    })()
    const maxEventId = uptoEventId
    if (maxEventId > 0) {
      try {
        ws.primeConversationCursor(conversationId, maxEventId)
      } catch {
        // ignore
      }
    }

    applyResumeConfig(conversationId, (res as any).config)
    baselineApplied.add(conversationId)
  } catch (error) {
    chatTrace('chat.session.baseline.error', {
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export async function hydrateConversation(
  conversationId: string,
  opts: { tail?: number; forceBaseline?: boolean } = {}
): Promise<Subscription | null> {
  if (!conversationId) return null
  if (opts.forceBaseline) baselineApplied.delete(conversationId)

  // 1) 首次进入做一次 HTTP baseline（幂等）
  await applyBaseline(conversationId)

  // 2) 基于 RxJS 的按需订阅：由调用方（组件）在 unmount 时自动退订
  try {
    // 若 baseline 后仍无任何 turns，则在握手开始前先行标记 hydrating，用于空态界面的中部提示
    try {
      const slice = chatTurnSelectors.sliceById(conversationId)(useChatTurnStore.getState())
      const turnsLen = Array.isArray(slice?.turns) ? slice.turns.length : 0
      if (turnsLen === 0) useChatHydrationStore.getState().setHydrating(conversationId, true)
    } catch {}
    const sub = ws.subscribeTopic$('chat', { conversationId }).subscribe({})
    // 预期握手容忍：若短时内未收到握手 begin，则清除预置的 hydrating，避免空态卡住
    try {
      const EXPECT = Number((import.meta as any).env?.VITE_CHAT_HANDSHAKE_EXPECT_MS ?? 800)
      setTimeout(
        () => {
          try {
            const st = useChatHydrationStore.getState()
            if (st.hydrating[conversationId]) st.setHydrating(conversationId, false)
          } catch {}
        },
        Math.max(200, EXPECT)
      )
    } catch {}
    chatTrace('chat.session.subscribe', { conversationId })
    return sub
  } catch (error) {
    chatTrace('chat.session.subscribe.error', {
      conversationId,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

// 兼容导出：不再需要显式释放，由组件的 Rx 订阅生命周期自动管理
export function releaseConversationSubscription(_conversationId: string) {}

export function resetConversationSessionForTests() {
  baselineApplied.clear()
}
