import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
// imports trimmed; logic split into core/snapshot slices
// (keep this file as thin composition + types)
import { createCoreSlice, STAGING_CID } from './chat-turns-core'
import { createSnapshotSlice } from './chat-turns-snapshot-slice'
import type {
  ChatTurnStore,
  TurnStoreActions,
  ConvSlice,
  TurnStoreState,
  Turn
} from './chat-turns.types'

export type {
  TurnStepKind,
  TurnStepStatus,
  TurnStatus,
  TurnStep,
  TurnReasoning,
  TurnAssistant,
  TurnUser,
  Turn,
  ConvSlice,
  TurnStoreState,
  TurnStoreActions,
  ChatTurnStore
} from './chat-turns.types'

type Store = ChatTurnStore

// helpers moved to slices; no local helpers here

// snapshot 构建与事件回放逻辑已下沉至 chat-turns-snapshot.ts

export const useChatTurnStore = create<Store>()(
  devtools(
    immer((set, get) => ({
      ...createCoreSlice(set, get),
      ...createSnapshotSlice(set, get)
    })),
    { name: 'ChatTurnStore' }
  )
)
export const chatTurnActions: TurnStoreActions = {
  setConversationId: (id) => useChatTurnStore.getState().setConversationId(id),
  setWsAutoSelectGuard: (enabled) => useChatTurnStore.getState().setWsAutoSelectGuard(enabled),
  reset: () => useChatTurnStore.getState().reset(),
  __beginFor: (cid) => useChatTurnStore.getState().__beginFor(cid),
  __endEvent: () => useChatTurnStore.getState().__endEvent(),
  addUserTurn: (text) => useChatTurnStore.getState().addUserTurn(text),
  setUserText: (text) => useChatTurnStore.getState().setUserText(text),
  markTurnStarted: (opts) => useChatTurnStore.getState().markTurnStarted(opts),
  appendAssistantDelta: (delta) => useChatTurnStore.getState().appendAssistantDelta(delta),
  completeAssistant: (text, ts, eventId) =>
    useChatTurnStore.getState().completeAssistant(text, ts, eventId),
  failAssistant: (message) => useChatTurnStore.getState().failAssistant(message),
  abortAssistant: () => useChatTurnStore.getState().abortAssistant(),
  appendReasoning: (delta) => useChatTurnStore.getState().appendReasoning(delta),
  endReasoning: (summary) => useChatTurnStore.getState().endReasoning(summary),
  markFinalMessageStarted: () => useChatTurnStore.getState().markFinalMessageStarted(),
  unmarkFinalMessageStarted: () => useChatTurnStore.getState().unmarkFinalMessageStarted(),
  addStep: (kind, callId, title, meta) =>
    useChatTurnStore.getState().addStep(kind, callId, title, meta),
  appendStep: (callId, text) => useChatTurnStore.getState().appendStep(callId, text),
  endStep: (callId, patch) => useChatTurnStore.getState().endStep(callId, patch),
  addInfo: (title, body) => useChatTurnStore.getState().addInfo(title, body),
  completeTurn: (opts) => useChatTurnStore.getState().completeTurn(opts),
  loadServerTurns: (turns) => useChatTurnStore.getState().loadServerTurns(turns),
  deriveWorkingState: (turnId) => useChatTurnStore.getState().deriveWorkingState(turnId),
  getLastAssistantPreview: (cid, max) =>
    useChatTurnStore.getState().getLastAssistantPreview(cid, max)
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as any).__chatTurnStore = useChatTurnStore
  ;(window as any).__chatTurnActions = chatTurnActions
}

// 单一入口：更安全地切换会话，带来源优先级
// 优先级：route(5) > new(4) > resume(3) > ws(2) > local(1)
let __conversationPrefWeight = 0
const weightMap: Record<string, number> = { route: 5, new: 4, resume: 3, ws: 2, local: 1 }
export function selectConversation(
  id?: string,
  opts?: { reason?: 'route' | 'new' | 'resume' | 'ws' | 'local' }
) {
  const current = useChatTurnStore.getState().conversationId
  const reason = opts?.reason || 'ws'
  const incoming = weightMap[reason] ?? 0
  if (!id) return
  if (current === id) {
    __conversationPrefWeight = Math.max(__conversationPrefWeight, incoming)
    return
  }
  if (current && __conversationPrefWeight > incoming) {
    // 低优先级来源不覆盖现有会话
    return
  }
  __conversationPrefWeight = incoming
  chatTurnActions.setConversationId(id)
}

// 统一策略：仅当当前已有显式选中的会话时，才允许 WS 自动切换
// 这样在 /chat（未选中会话）时不会被其他会话的后续消息“劫持”
export function selectConversationFromWs(id?: string) {
  if (!id) return
  try {
    const st = useChatTurnStore.getState()
    // 若开启了 WS 自动切换保护，则禁止由 WS 事件选中会话
    if (st?.wsAutoSelectGuard) return
  } catch {
    return
  }
  selectConversation(id, { reason: 'ws' })
}

const EMPTY_SLICE: ConvSlice = {
  turns: [],
  activeTurnId: undefined,
  nextSeq: 0,
  toolIndex: {},
  toolHistory: {},
  generating: false,
  lastAccess: undefined,
  turnIndex: {},
  streamingIndex: {}
}

export const chatTurnSelectors = {
  currentSlice: (state: TurnStoreState): ConvSlice => {
    const key = state.conversationId ?? STAGING_CID
    return state.byConv[key] ?? state.byConv[STAGING_CID] ?? EMPTY_SLICE
  },
  sliceById:
    (conversationId: string) =>
    (state: TurnStoreState): ConvSlice => {
      return state.byConv[conversationId] ?? EMPTY_SLICE
    },
  stagingSlice: (state: TurnStoreState): ConvSlice => {
    return state.byConv[STAGING_CID] ?? EMPTY_SLICE
  },
  currentTurns: (state: TurnStoreState): Turn[] => {
    return chatTurnSelectors.currentSlice(state).turns
  },
  currentGenerating: (state: TurnStoreState): boolean => {
    return chatTurnSelectors.currentSlice(state).generating
  }
}

export const chatTurnStoreUtils = {
  currentSlice: () => chatTurnSelectors.currentSlice(useChatTurnStore.getState()),
  currentTurns: () => chatTurnSelectors.currentTurns(useChatTurnStore.getState()),
  currentGenerating: () => chatTurnSelectors.currentGenerating(useChatTurnStore.getState())
}
