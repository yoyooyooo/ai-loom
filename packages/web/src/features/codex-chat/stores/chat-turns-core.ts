import { createId } from '@/lib/id'
import type {
  ChatTurnStore,
  ChatTurnStoreCreator,
  ConvSlice,
  Turn,
  TurnStep
} from './chat-turns.types'
import { appendExecOutput, clearExecOutput } from './exec-output-vault'

export const STAGING_CID = '__staging__'

type CoreCreator = ChatTurnStoreCreator<ChatTurnStoreCreator.Core>

const EMPTY_SLICE_READONLY: ConvSlice = Object.freeze({
  turns: [],
  activeTurnId: undefined,
  nextSeq: 0,
  toolIndex: {},
  toolHistory: {},
  generating: false,
  lastAccess: undefined,
  turnIndex: {},
  streamingIndex: {}
})

function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first
      .replace(/^[\s#>*_`]+/, '')
      .replace(/[\s#*_`]+$/, '')
      .trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

function nowISO() {
  return new Date().toISOString()
}

function calcGenerating(turns: Turn[]): boolean {
  return turns.some((turn) => {
    if (turn.status === 'streaming') return true
    return Array.isArray(turn.steps) && turn.steps.some((step: any) => step.status === 'streaming')
  })
}

function createStreamingTurn(
  conversationId: string | undefined,
  nextSeq: number | undefined,
  userText?: string
): Turn {
  const seq = (nextSeq ?? 0) + 1
  const ts = nowISO()
  return {
    id: createId('turn'),
    seq,
    conversationId: (conversationId as any) ?? null,
    startedAt: ts,
    completedAt: null,
    status: 'streaming',
    user: { text: userText ?? '', ts },
    assistant: { text: '', ts },
    reasoning: null,
    steps: [],
    meta: null
  }
}

function ensureTurnReasoning(turn: Turn) {
  if (turn.reasoning) return turn.reasoning
  const empty: any = { title: null, content: '' }
  ;(turn as any).reasoning = empty
  return empty
}

function mergeStepBody(prev: string | null | undefined, next: string): string {
  if (!prev) return next
  if (!next) return prev
  return prev.length === 0 ? next : `${prev}${prev.endsWith('\n') ? '' : '\n'}${next}`
}

function getMaxOutputChars(): number {
  try {
    const v = (import.meta as any).env?.VITE_CHAT_TOOL_MAX_OUTPUT_CHARS
    if (v == null) return 100_000
    const n = Number(v)
    return Number.isFinite(n) && n > 1024 ? Math.floor(n) : 100_000
  } catch {
    return 100_000
  }
}

function truncateIfNeeded(step: any) {
  try {
    const max = getMaxOutputChars()
    const body = String(step.body || '')
    if (body.length <= max) return
    // 头尾各保留一半，避免信息丢失
    const keepHead = Math.floor(max * 0.7)
    const keepTail = Math.max(0, max - keepHead)
    const head = body.slice(0, keepHead)
    const tail = keepTail > 0 ? body.slice(-keepTail) : ''
    const marker = `\n…(truncated, total=${body.length})\n`
    step.body = `${head}${marker}${tail}`
    const prevMeta = step.meta || {}
    step.meta = { ...prevMeta, truncated: true, totalLength: body.length, maxLength: max }
  } catch {}
}

function hideNonPatchOutputsEnabled(): boolean {
  try {
    const v = (import.meta as any).env?.VITE_CHAT_HIDE_NONPATCH_OUTPUTS
    // 默认关闭：仅当显式设置为 1/true/yes 时才隐藏
    if (v == null) return false
    const s = String(v).toLowerCase()
    return s === '1' || s === 'true' || s === 'yes'
  } catch {
    return false
  }
}

function createEmptySlice(): ConvSlice {
  return {
    turns: [],
    activeTurnId: undefined,
    nextSeq: 0,
    toolIndex: {},
    toolHistory: {},
    generating: false,
    lastAccess: Date.now(),
    turnIndex: {},
    // 运行时索引：处于 streaming 状态的 turnId 集合（Object 代替 Set，便于序列化）
    streamingIndex: {}
  }
}

function bumpVersion(state: ChatTurnStore) {
  state.version = (state.version || 0) + 1
}

function registerTurn(state: ChatTurnStore, cid: string, conv: ConvSlice, turn: Turn) {
  if (!conv.turnIndex) conv.turnIndex = {}
  conv.turnIndex[turn.id] = Math.max(0, conv.turns.length - 1)
  if (!state.turnLocator) state.turnLocator = {}
  state.turnLocator[turn.id] = { conversationId: cid }
  if (!(conv as any).toolHistory) (conv as any).toolHistory = {}
}

function registerTurns(state: ChatTurnStore, cid: string, conv: ConvSlice) {
  if (!Array.isArray(conv.turns)) return
  if (!conv.turnIndex) conv.turnIndex = {}
  if (!(conv as any).toolHistory) (conv as any).toolHistory = {}
  const history = conv.toolHistory
  for (const key of Object.keys(history)) delete history[key]
  for (let i = 0; i < conv.turns.length; i += 1) {
    const turn = conv.turns[i]
    conv.turnIndex[turn.id] = i
    if (!state.turnLocator) state.turnLocator = {}
    state.turnLocator[turn.id] = { conversationId: cid }
    if (Array.isArray(turn.steps)) {
      for (const step of turn.steps as any[]) {
        const callId = step?.meta?.callId
        if (!callId) continue
        history[callId] = { turnId: turn.id, stepId: step.id }
      }
    }
  }
}

function unregisterTurns(state: ChatTurnStore, cid: string, conv: ConvSlice | undefined) {
  if (!conv || !Array.isArray(conv.turns)) return
  if (state.turnLocator) {
    for (const turn of conv.turns) {
      if (turn?.id) delete state.turnLocator[turn.id]
    }
  }
  conv.turnIndex = {}
  if (conv.toolIndex) conv.toolIndex = {}
  if ((conv as any).toolHistory) (conv as any).toolHistory = {}
}

function getMaxSlices() {
  try {
    const v = (import.meta as any).env?.VITE_CHAT_TURNS_MAX_SLICES
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 30
  } catch {
    return 30
  }
}

function isSliceEmpty(slice: ConvSlice): boolean {
  return (
    (!slice.turns || slice.turns.length === 0) &&
    !slice.activeTurnId &&
    Object.keys(slice.toolIndex || {}).length === 0 &&
    !slice.generating
  )
}

function lruTrim(state: ChatTurnStore, keep: Set<string>) {
  const by = state.byConv || {}
  const ids = Object.keys(by)
  const max = getMaxSlices()
  if (ids.length <= max) return
  const removable: Array<{ id: string; ts: number }> = []
  for (const id of ids) {
    if (keep.has(id) || id === STAGING_CID) continue
    const conv = by[id]
    if (conv?.generating) continue
    const ts = Number(conv?.lastAccess || 0)
    removable.push({ id, ts })
  }
  removable.sort((a, b) => a.ts - b.ts)
  let need = ids.length - max
  for (const r of removable) {
    if (need <= 0) break
    const slice = by[r.id]
    unregisterTurns(state, r.id, slice)
    delete by[r.id]
    need -= 1
  }
}

function ensureConv(state: ChatTurnStore, cid: string): ConvSlice {
  const by = state.byConv || (state.byConv = {})
  let conv = by[cid]
  if (!conv) {
    conv = createEmptySlice()
    by[cid] = conv
    const keep = new Set<string>([cid, STAGING_CID])
    if (state.conversationId) keep.add(state.conversationId)
    if (state.__eventCid) keep.add(state.__eventCid)
    lruTrim(state, keep)
  }
  if (!conv.turnIndex) conv.turnIndex = {}
  if (!(conv as any).streamingIndex) (conv as any).streamingIndex = {}
  if (!(conv as any).toolHistory) (conv as any).toolHistory = {}
  if (Array.isArray(conv.turns) && conv.turns.length > 0) {
    const indexSize = Object.keys(conv.turnIndex).length
    if (indexSize !== conv.turns.length) {
      conv.turnIndex = {}
      if (!state.turnLocator) state.turnLocator = {}
      for (let i = 0; i < conv.turns.length; i += 1) {
        const turn = conv.turns[i]
        conv.turnIndex[turn.id] = i
        state.turnLocator[turn.id] = { conversationId: cid }
      }
    }
  }
  conv.lastAccess = Date.now()
  return conv
}

function ensureStaging(state: ChatTurnStore): ConvSlice {
  return ensureConv(state, STAGING_CID)
}

function targetCid(state: ChatTurnStore): string {
  return state.__eventCid || state.conversationId || STAGING_CID
}

function effectiveConversationId(cid: string): string | undefined {
  return cid === STAGING_CID ? undefined : cid
}

function promoteStagingIfPossible(state: ChatTurnStore, destinationCid: string) {
  const staging = state.byConv?.[STAGING_CID]
  if (!staging || isSliceEmpty(staging)) return
  const dest = state.byConv?.[destinationCid]
  if (dest && !isSliceEmpty(dest)) return
  const now = Date.now()
  const target = dest && isSliceEmpty(dest) ? dest : createEmptySlice()
  target.turns = []
  target.turnIndex = {}
  target.toolIndex = { ...(staging.toolIndex || {}) }
  target.toolHistory = { ...(staging.toolHistory || {}) }
  target.activeTurnId = staging.activeTurnId
  target.nextSeq = staging.nextSeq
  target.generating = staging.generating
  target.lastAccess = now
  for (const turn of staging.turns) {
    if (turn.conversationId !== destinationCid) {
      ;(turn as any).conversationId = destinationCid
    }
    target.turns.push(turn)
    registerTurn(state, destinationCid, target, turn)
  }
  state.byConv[destinationCid] = target
  unregisterTurns(state, STAGING_CID, staging)
  state.byConv[STAGING_CID] = createEmptySlice()
  bumpVersion(state)
}

function readSlice(state: ChatTurnStore, cid?: string): ConvSlice {
  const key = cid ?? state?.conversationId ?? STAGING_CID
  return state.byConv?.[key] || state.byConv?.[STAGING_CID] || (EMPTY_SLICE_READONLY as ConvSlice)
}

export function createCoreSlice(
  set: Parameters<CoreCreator>[0],
  get: Parameters<CoreCreator>[1]
): ReturnType<CoreCreator> {
  return {
    conversationId: undefined as string | undefined,
    byConv: { [STAGING_CID]: createEmptySlice() } as Record<string, ConvSlice>,
    __eventCid: undefined as string | undefined,
    turnLocator: {} as Record<string, { conversationId: string }>,
    version: 0,
    wsAutoSelectGuard: false,

    __beginFor(cid?: string) {
      set({ __eventCid: cid }, false, 'turns/__beginFor')
    },

    __endEvent() {
      set({ __eventCid: undefined }, false, 'turns/__endEvent')
    },

    setConversationId(id?: string) {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          try {
            if (typeof window !== 'undefined') {
              if (id) localStorage.setItem('chat.conversationId', id)
              else localStorage.removeItem('chat.conversationId')
            }
          } catch {}
          const prev = state.conversationId
          state.conversationId = id
          if (id) {
            ensureConv(state, id)
            if (prev !== id) promoteStagingIfPossible(state, id)
          }
          return
        },
        false,
        'turns/setConversationId'
      )
    },

    setWsAutoSelectGuard(enabled: boolean) {
      set(
        (state: ChatTurnStore) => {
          state.wsAutoSelectGuard = !!enabled
          return
        },
        false,
        'turns/setWsAutoSelectGuard'
      )
    },

    reset() {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const cid = state.conversationId || STAGING_CID
          const existing = state.byConv?.[cid]
          unregisterTurns(state, cid, existing)
          state.byConv[cid] = createEmptySlice()
          bumpVersion(state)
          return
        },
        false,
        'turns/reset'
      )
    },

    addUserTurn(text: string) {
      const trimmed = String(text ?? '')
      const cid = targetCid(get())
      let turnId = ''
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const effectiveCid = effectiveConversationId(key)
          const turn = createStreamingTurn(effectiveCid, conv.nextSeq, trimmed)
          conv.turns.push(turn)
          registerTurn(state, key, conv, turn)
          conv.activeTurnId = turn.id
          conv.nextSeq = turn.seq
          ;(conv as any).streamingIndex[turn.id] = true
          conv.generating = true
          conv.lastAccess = Date.now()
          bumpVersion(state)
          turnId = turn.id
          return
        },
        false,
        'turns/addUserTurn'
      )
      return turnId
    },

    setUserText(text?: string) {
      const trimmed = String(text ?? '')
      if (!trimmed) return
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const effectiveCid = effectiveConversationId(key)
          let targetId = conv.activeTurnId
          let targetIdx = targetId != null ? conv.turnIndex[targetId] : undefined
          let target = typeof targetIdx === 'number' ? conv.turns[targetIdx] : undefined
          if (target && target.status !== 'streaming') target = undefined
          if (!target) {
            const existing = [...conv.turns].reverse().find((t) => t.status === 'streaming')
            if (existing) {
              target = existing
              targetId = existing.id
              targetIdx = conv.turnIndex[targetId]
            }
          }
          if (!target) {
            const turn = createStreamingTurn(effectiveCid, conv.nextSeq)
            conv.turns.push(turn)
            registerTurn(state, key, conv, turn)
            target = turn
            targetId = turn.id
            targetIdx = conv.turnIndex[targetId]
            conv.nextSeq = turn.seq
          }
          const ts = nowISO()
          target.user = { text: trimmed, ts }
          conv.activeTurnId = targetId
          if (targetId) (conv as any).streamingIndex[targetId] = true
          if (typeof target.seq === 'number' && (conv.nextSeq ?? 0) < target.seq) {
            conv.nextSeq = target.seq
          }
          conv.generating = true
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/setUserText'
      )
    },

    markTurnStarted(opts?: { startedAt?: string }) {
      const ts = opts?.startedAt ?? nowISO()
      let ensuredId = ''
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const effectiveCid = effectiveConversationId(key)
          let targetId = conv.activeTurnId
          let targetIdx = targetId != null ? conv.turnIndex[targetId] : undefined
          let target = typeof targetIdx === 'number' ? conv.turns[targetIdx] : undefined
          if (target && target.status !== 'streaming') target = undefined
          if (!target) {
            const existing = [...conv.turns].reverse().find((t) => t.status === 'streaming')
            if (existing) {
              target = existing
              targetId = existing.id
              targetIdx = conv.turnIndex[targetId]
            }
          }
          if (!target) {
            const turn = createStreamingTurn(effectiveCid, conv.nextSeq)
            conv.turns.push(turn)
            registerTurn(state, key, conv, turn)
            target = turn
            targetId = turn.id
            targetIdx = conv.turnIndex[targetId]
            conv.nextSeq = turn.seq
          }
          if (!targetId) return
          ensuredId = targetId
          target.startedAt = ts
          if (typeof target.seq === 'number' && (conv.nextSeq ?? 0) < target.seq) {
            conv.nextSeq = target.seq
          }
          conv.activeTurnId = targetId
          if (targetId) (conv as any).streamingIndex[targetId] = true
          conv.generating = true
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/markTurnStarted'
      )
      return ensuredId
    },

    appendAssistantDelta(delta?: string) {
      if (!delta) return
      set(
        (state: ChatTurnStore) => {
          const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          let targetId = conv.activeTurnId
          let targetIdx = targetId != null ? conv.turnIndex[targetId] : undefined
          let target = typeof targetIdx === 'number' ? conv.turns[targetIdx] : undefined
          if (target && target.status !== 'streaming') target = undefined
          if (!target) {
            target = [...conv.turns].reverse().find((t) => t.status === 'streaming')
            if (!target) return
            targetId = target.id
            targetIdx = conv.turnIndex[targetId]
          }
          const assistant = target.assistant || { text: '' }
          if (!hideNonPatchOutputsEnabled()) {
            assistant.text = (assistant.text || '') + delta
          } else {
            // 隐藏正文：不累积正文，保持空文本
            assistant.text = ''
          }
          target.assistant = assistant
          target.status = 'streaming'
          conv.activeTurnId = targetId
          if (targetId) (conv as any).streamingIndex[targetId] = true
          if (typeof target.seq === 'number' && (conv.nextSeq ?? 0) < target.seq) {
            conv.nextSeq = target.seq
          }
          conv.generating = true
          if (!isVitest) {
            conv.lastAccess = Date.now()
            bumpVersion(state)
          }
          return
        },
        false,
        'turns/appendAssistantDelta'
      )
    },

    completeAssistant(text?: string, atTs?: string, eventId?: number) {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          const ts = typeof atTs === 'string' ? atTs : nowISO()
          const assistantText = hideNonPatchOutputsEnabled()
            ? ''
            : typeof text === 'string'
              ? text
              : (target.assistant?.text ?? '')
          target.assistant = { text: assistantText, ts }
          if (!target.meta) target.meta = {}
          const extraPrev: any = (target.meta as any)?.extra || {}
          const assistantCompletedEventId =
            typeof eventId === 'number' && Number.isFinite(eventId) && eventId > 0
              ? Math.floor(eventId)
              : extraPrev.assistantCompletedEventId
          target.meta = { ...(target.meta as any), extra: { ...extraPrev, assistantCompletedEventId } }
          const wasStreaming = target.status === 'streaming'
          if (target.status !== 'failed' && target.status !== 'aborted') {
            target.status = 'completed'
          }
          // 若该 turn 已无 streaming，移除索引
          const still =
            wasStreaming || (target.steps || []).some((s: any) => s.status === 'streaming')
          if (!still) delete (conv as any).streamingIndex[targetId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/completeAssistant'
      )
    },

    failAssistant(message?: string) {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          target.assistant = {
            text: message ? String(message) : (target.assistant?.text ?? ''),
            ts: nowISO()
          }
          target.status = 'failed'
          delete (conv as any).streamingIndex[targetId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/failAssistant'
      )
    },

    abortAssistant() {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          target.status = 'aborted'
          target.assistant = { text: target.assistant?.text ?? '', ts: nowISO() }
          delete (conv as any).streamingIndex[targetId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/abortAssistant'
      )
    },

    appendReasoning(delta?: string) {
      if (!delta) return
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          if (hideNonPatchOutputsEnabled()) {
            // 隐藏正文：不累积 reasoning 文本，仅更新 streaming 状态
            target.status = 'streaming'
            ;(conv as any).streamingIndex[targetId] = true
            conv.generating = true
            conv.lastAccess = Date.now()
            bumpVersion(state)
            return
          } else {
            const reasoning = ensureTurnReasoning(target)
            reasoning.content = (reasoning.content || '') + delta
            target.reasoning = reasoning
            target.status = 'streaming'
            ;(conv as any).streamingIndex[targetId] = true
            conv.generating = true
            conv.lastAccess = Date.now()
            bumpVersion(state)
            return
          }
        },
        false,
        'turns/appendReasoning'
      )
    },

    endReasoning(summary?: string) {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          const content = String(summary ?? '')
          if (hideNonPatchOutputsEnabled()) {
            // 隐藏正文：仅保存标题摘要，正文不保留
            const title = summarizeFirstLine(content)
            target.reasoning = { content: '', title }
          } else {
            if (!content.trim()) {
              if (target.reasoning) {
                const reasoning = target.reasoning
                reasoning.title = summarizeFirstLine(reasoning.content)
                target.reasoning = reasoning
              }
            } else {
              target.reasoning = {
                content,
                title: summarizeFirstLine(content)
              }
            }
          }
          const still =
            target.status === 'streaming' ||
            (target.steps || []).some((s: any) => s.status === 'streaming')
          if (!still) delete (conv as any).streamingIndex[targetId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/endReasoning'
      )
    },

    markFinalMessageStarted() {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          const meta = target.meta || {}
          const extra = { ...(meta.extra || {}), finalMessageStarted: true }
          target.meta = { ...meta, extra }
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/markFinalMessageStarted'
      )
    },

    unmarkFinalMessageStarted() {
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          const meta: any = target.meta || {}
          const prevExtra: any = meta.extra || {}
          if (!prevExtra.finalMessageStarted) return
          const { finalMessageStarted, ...restExtra } = prevExtra
          target.meta = { ...meta, extra: restExtra }
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/unmarkFinalMessageStarted'
      )
    },

    addStep(
      kind: any,
      callId: string | undefined,
      title: string,
      options?: { meta?: any; tags?: string[]; status?: any; body?: string }
    ) {
      const detailId = createId(kind)
      const ts = nowISO()
      let reusedId: string | undefined
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)

          const tryUpgradeExisting = (step: any, turnId: string | undefined, turn?: Turn) => {
            if (!step) return false
            if (kind !== 'patch' && kind !== 'plan') return false
            step.kind = kind
            step.title = title || `[${kind}]`
            if (options?.body !== undefined) step.body = options.body
            if (step.body == null) step.body = ''
            const nextStatus = options?.status ?? step.status ?? 'streaming'
            step.status = nextStatus
            const prevMeta = step.meta || {}
            const incomingMeta = options?.meta || {}
            const merged: any = { ...prevMeta, ...incomingMeta }
            if (callId) merged.callId = callId
            if (kind === 'patch' && (prevMeta.patch || incomingMeta.patch)) {
              merged.patch = { ...(prevMeta.patch || {}), ...(incomingMeta.patch || {}) }
            }
            step.meta = merged
            if (callId && turnId) {
              const pointer = { turnId, stepId: step.id }
              if (kind === 'plan') {
                if (nextStatus === 'streaming') {
                  conv.toolIndex[callId] = pointer
                } else {
                  delete conv.toolIndex[callId]
                }
              } else {
                conv.toolIndex[callId] = pointer
              }
              conv.toolHistory[callId] = pointer
            }
            if (turnId) conv.activeTurnId = turnId
            if (turnId && turn) {
              const still =
                turn.status === 'streaming' ||
                (Array.isArray(turn.steps) &&
                  turn.steps.some((s: any) => s?.status === 'streaming'))
              if (still) {
                ;(conv as any).streamingIndex[turnId] = true
              } else {
                delete (conv as any).streamingIndex[turnId]
              }
            }
            conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
            conv.lastAccess = Date.now()
            bumpVersion(state)
            reusedId = step.id
            return true
          }

          const locateStepByCallId = (id: string | undefined) => {
            if (!id) return undefined
            const pointer = conv.toolIndex[id] || conv.toolHistory[id]
            if (!pointer) return undefined
            const entryIndex = conv.turnIndex[pointer.turnId]
            const entryTurn = typeof entryIndex === 'number' ? conv.turns[entryIndex] : undefined
            if (!entryTurn || !Array.isArray(entryTurn.steps)) return undefined
            const existing = entryTurn.steps.find(
              (s: any) => s.id === pointer.stepId || s?.meta?.callId === id
            )
            if (!existing) return undefined
            return { step: existing, turnId: pointer.turnId, turn: entryTurn }
          }

          if (callId) {
            const located = locateStepByCallId(callId)
            if (located) {
              if (tryUpgradeExisting(located.step, located.turnId, located.turn)) return
              return
            }
          }

          let targetId = conv.activeTurnId
          let targetIndex = targetId != null ? conv.turnIndex[targetId] : undefined
          let target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) {
            const streaming = [...conv.turns].reverse().find((t) => t.status === 'streaming')
            if (streaming) {
              target = streaming
              targetId = streaming.id
              targetIndex = conv.turnIndex[targetId]
            } else if (kind === 'info' || kind === 'plan') {
              const last = conv.turns[conv.turns.length - 1]
              if (!last) return
              target = last
              targetId = last.id
              targetIndex = conv.turnIndex[targetId]
            } else {
              const newTurn = createStreamingTurn(effectiveConversationId(key), conv.nextSeq)
              conv.turns.push(newTurn)
              registerTurn(state, key, conv, newTurn)
              target = newTurn
              targetId = newTurn.id
              targetIndex = conv.turnIndex[targetId]
              conv.nextSeq = newTurn.seq
            }
          }
          if (!target || !targetId) return

          const meta = { ...(options?.meta || {}), ...(callId ? { callId } : {}) }
          const step: TurnStep = {
            id: detailId,
            kind,
            title: title || `[${kind}]`,
            body: (() => {
              const hide = hideNonPatchOutputsEnabled()
              if (hide && !(kind === 'patch' || kind === 'thinking')) return ''
              return options?.body ?? ''
            })(),
            status: options?.status ?? 'streaming',
            ts,
            tags: (options?.tags ?? null) as any,
            meta
          }
          if (!Array.isArray(target.steps)) target.steps = []
          target.steps.push(step)
          conv.activeTurnId = targetId

          if (callId) {
            const pointer = { turnId: targetId, stepId: detailId }
            if (kind === 'plan') {
              if ((step.status ?? 'streaming') === 'streaming') {
                conv.toolIndex[callId] = pointer
              } else {
                delete conv.toolIndex[callId]
              }
            } else {
              conv.toolIndex[callId] = pointer
            }
            conv.toolHistory[callId] = pointer
          }

          if (typeof target.seq === 'number' && (conv.nextSeq ?? 0) < target.seq) {
            conv.nextSeq = target.seq
          }

          const still =
            target.status === 'streaming' ||
            (Array.isArray(target.steps) &&
              target.steps.some((s: any) => s?.status === 'streaming'))
          if (still) {
            ;(conv as any).streamingIndex[targetId] = true
          } else {
            delete (conv as any).streamingIndex[targetId]
          }
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/addStep'
      )
      return reusedId ?? detailId
    },

    appendStep(callId: string, text: string) {
      if (!callId || !text) return
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const entry = conv.toolIndex[callId]
          if (!entry) return
          const turnIndex = conv.turnIndex[entry.turnId]
          const turn = typeof turnIndex === 'number' ? conv.turns[turnIndex] : undefined
          if (!turn) return
          const steps = Array.isArray(turn.steps) ? turn.steps : (turn.steps = [])
          const step = steps.find((s: any) => s.id === entry.stepId)
          if (!step) return
          const hide = hideNonPatchOutputsEnabled()
          if (!hide || step.kind === 'patch' || step.kind === 'thinking') {
            step.body = mergeStepBody(step.body, text)
            // 同步完整输出到影子存储（优先 callId；退化为 stepId），不触发渲染
            try {
              const isVitest = typeof process !== 'undefined' && !!(process as any)?.env?.VITEST
              if (!isVitest) {
                const key = (step as any)?.meta?.callId || entry.stepId
                appendExecOutput(String(key), text)
              }
            } catch {}
            truncateIfNeeded(step)
          }
          ;(conv as any).streamingIndex[entry.turnId] = true
          conv.generating = true
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/appendStep'
      )
    },

    endStep(callId: string, patch?: any) {
      if (!callId) return
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const entry = conv.toolIndex[callId]
          if (!entry) return
          const turnIndex = conv.turnIndex[entry.turnId]
          const turn = typeof turnIndex === 'number' ? conv.turns[turnIndex] : undefined
          if (!turn) return
          const steps = Array.isArray(turn.steps) ? turn.steps : (turn.steps = [])
          const step = steps.find((s: any) => s.id === entry.stepId)
          if (!step) return
          const nextStatus = patch?.status ?? 'completed'
          const nextBody = patch?.body ?? step.body
          step.status = nextStatus
          step.body = nextBody
          if (patch?.meta) {
            const prevMeta = step.meta || {}
            const incomingMeta = patch.meta || {}
            const merged: any = { ...prevMeta, ...incomingMeta }
            if (prevMeta.patch || incomingMeta.patch) {
              merged.patch = { ...(prevMeta.patch || {}), ...(incomingMeta.patch || {}) }
            }
            step.meta = merged
          }
          conv.toolHistory[callId] = { turnId: entry.turnId, stepId: entry.stepId }
          delete conv.toolIndex[callId]
          const still =
            turn.status === 'streaming' ||
            (turn.steps || []).some((s: any) => s.status === 'streaming')
          if (!still) delete (conv as any).streamingIndex[entry.turnId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/endStep'
      )
    },

    addInfo(title: string, body?: string) {
      const ts = nowISO()
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const previousActive = conv.activeTurnId
          let targetId = conv.activeTurnId
          let targetIndex = targetId != null ? conv.turnIndex[targetId] : undefined
          let target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) {
            const fallback =
              [...conv.turns].reverse().find((t) => t.status === 'streaming') ??
              conv.turns[conv.turns.length - 1]
            if (!fallback) return
            target = fallback
            targetId = fallback.id
            targetIndex = conv.turnIndex[targetId]
          }
          if (!target) return
          const step: TurnStep = {
            id: createId('info'),
            kind: 'info',
            title,
            body: hideNonPatchOutputsEnabled() ? null : (body ?? null),
            status: 'completed',
            ts,
            tags: null,
            meta: null
          }
          if (!Array.isArray(target.steps)) target.steps = []
          target.steps.push(step)
          if (target.status === 'streaming') {
            conv.activeTurnId = targetId
          } else {
            conv.activeTurnId = previousActive
          }
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/addInfo'
      )
    },

    completeTurn(opts?: { completedAt?: string }) {
      const completedAt = opts?.completedAt ?? nowISO()
      set(
        (state: ChatTurnStore) => {
          ensureStaging(state)
          const key = targetCid(state)
          const conv = ensureConv(state, key)
          const targetId = conv.activeTurnId
          if (!targetId) return
          const targetIndex = conv.turnIndex[targetId]
          const target = typeof targetIndex === 'number' ? conv.turns[targetIndex] : undefined
          if (!target) return
          const status =
            target.status === 'failed' || target.status === 'aborted' ? target.status : 'completed'
          target.status = status
          target.completedAt = completedAt
          if (Array.isArray(target.steps)) {
            target.steps.forEach((s: any) => {
              if (s?.status === 'streaming') s.status = 'completed'
            })
          }
          for (const [key, value] of Object.entries(conv.toolIndex)) {
            if (value?.turnId === targetId) delete conv.toolIndex[key]
          }
          // 清理影子缓存（该 turn 的完整输出）
          if (Array.isArray(target.steps)) {
            for (const s of target.steps as any[]) {
              const k = (s?.meta?.callId as string) || (s?.id as string)
              if (k)
                try {
                  clearExecOutput(String(k))
                } catch {}
            }
          }
          conv.activeTurnId = undefined
          delete (conv as any).streamingIndex[targetId]
          conv.generating = Object.keys((conv as any).streamingIndex || {}).length > 0
          conv.lastAccess = Date.now()
          bumpVersion(state)
          return
        },
        false,
        'turns/completeTurn'
      )
    },

    deriveWorkingState(turnId: string) {
      const state = get()
      const loc = state.turnLocator ? state.turnLocator[turnId] : undefined
      if (!loc) {
        return { working: false, detailsCount: 0, workingTitle: 'Finished working' }
      }
      const slice = state.byConv?.[loc.conversationId]
      const turnIndex = slice?.turnIndex?.[turnId]
      const turn = typeof turnIndex === 'number' ? slice?.turns?.[turnIndex] : undefined
      if (!turn) {
        return { working: false, detailsCount: 0, workingTitle: 'Finished working' }
      }
      const finalStarted = !!(turn.meta as any)?.extra?.finalMessageStarted
      const stepsStreaming = (turn.steps || []).some((step: any) => step.status === 'streaming')
      const working = stepsStreaming || (!finalStarted && turn.status === 'streaming')
      const detailsCount = (turn.steps || []).length
      const workingTitle =
        turn.status === 'failed'
          ? 'Failed'
          : turn.status === 'aborted'
            ? 'Aborted'
            : working
              ? 'Working'
              : 'Finished working'
      return { working, detailsCount, workingTitle }
    },

    getLastAssistantPreview(conversationId: string, max: number = 120): string | null {
      try {
        const state = get()
        const slice = readSlice(state, conversationId)
        if (!slice || !Array.isArray(slice.turns) || slice.turns.length === 0) return null
        const last = slice.turns[slice.turns.length - 1]
        const assistantText = (last?.assistant?.text || '').trim()
        if (assistantText) {
          return assistantText.length > max ? `${assistantText.slice(0, max)}…` : assistantText
        }
        const reasoning = (last?.reasoning?.content || '').trim()
        if (reasoning) {
          const summary = summarizeFirstLine(reasoning, max)
          return summary.length > max ? `${summary.slice(0, max)}…` : summary
        }
        const thinking = Array.isArray(last?.steps)
          ? last.steps.find((s: any) => s?.kind === 'thinking')
          : null
        const thinkingBody = ((thinking?.body || thinking?.title || '') as string).trim()
        if (thinkingBody) {
          const summary = summarizeFirstLine(thinkingBody, max)
          return summary.length > max ? `${summary.slice(0, max)}…` : summary
        }
        return null
      } catch {
        return null
      }
    }
  }
}
