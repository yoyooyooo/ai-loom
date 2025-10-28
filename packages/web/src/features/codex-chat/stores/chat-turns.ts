import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
// imports trimmed; logic split into core/snapshot slices
// (keep this file as thin composition + types)
import { createCoreSlice } from './chat-turns-core'
import { createSnapshotSlice } from './chat-turns-snapshot-slice'

export type TurnStepKind =
  | 'read'
  | 'list'
  | 'search'
  | 'exec'
  | 'patch'
  | 'mcp'
  | 'info'
  | 'thinking'
  | 'plan'

export type TurnStepStatus = 'streaming' | 'completed' | 'failed' | 'aborted'

export type TurnStatus = 'streaming' | 'completed' | 'failed' | 'aborted'

export type TurnStep = {
  id: string
  kind: TurnStepKind
  title: string
  body?: string
  tags?: string[]
  status: TurnStepStatus
  ts: string
  meta?: any
}

export type TurnReasoning = {
  title?: string
  content: string
}

export type TurnAssistant = {
  text: string
  ts?: string
}

export type TurnUser = {
  text: string
  ts: string
}

export type Turn = {
  id: string
  seq: number
  conversationId?: string
  startedAt?: string
  completedAt?: string
  status: TurnStatus
  user: TurnUser
  assistant: TurnAssistant
  reasoning?: TurnReasoning
  steps: TurnStep[]
  meta?: {
    model?: string
    tokenCount?: any
    extra?: any
  }
}

export type TurnStoreState = {
  conversationId?: string
  turns: Turn[]
  activeTurnId?: string
  nextSeq: number
  toolIndex: Record<string, { turnId: string; stepId: string }>
  generating: boolean
}

export type TurnStoreActions = {
  setConversationId: (id: string | undefined) => void
  reset: () => void
  addUserTurn: (text: string) => string
  setUserText: (text: string) => void
  markTurnStarted: (opts?: { startedAt?: string }) => string
  appendAssistantDelta: (delta: string) => void
  completeAssistant: (text?: string) => void
  failAssistant: (message?: string) => void
  abortAssistant: () => void
  appendReasoning: (delta: string) => void
  endReasoning: (summary: string) => void
  addStep: (
    kind: TurnStepKind,
    callId: string | undefined,
    title: string,
    options?: { meta?: any; tags?: string[]; status?: TurnStepStatus; body?: string }
  ) => string
  appendStep: (callId: string, text: string) => void
  endStep: (callId: string, patch?: Partial<TurnStep>) => void
  addInfo: (title: string, body?: string) => void
  completeTurn: (opts?: { completedAt?: string }) => void
  loadFromHistory: (
    items: Array<{
      role: 'user' | 'assistant' | 'reasoning'
      text: string
      reasoning?: string | null
    }>
  ) => void
  loadSnapshot: (
    history: Array<{
      role: 'user' | 'assistant' | 'reasoning'
      text: string
      reasoning?: string | null
    }>,
    events: Array<{ method: string; params?: Record<string, any> | null | undefined }>
  ) => void
  deriveWorkingState: (turnId: string) => {
    working: boolean
    detailsCount: number
    workingTitle: string
  }
}

type Store = TurnStoreState & TurnStoreActions

// helpers moved to slices; no local helpers here


// snapshot 构建与事件回放逻辑已下沉至 chat-turns-snapshot.ts

export const useChatTurnStore = create<Store>()(
  devtools(
    (set, get) => ({
      ...createCoreSlice(set, get),
      ...createSnapshotSlice(set, get)
    }),
    { name: 'ChatTurnStore' }
  )
)
export const chatTurnActions: TurnStoreActions = {
  setConversationId: (id) => useChatTurnStore.getState().setConversationId(id),
  reset: () => useChatTurnStore.getState().reset(),
  addUserTurn: (text) => useChatTurnStore.getState().addUserTurn(text),
  setUserText: (text) => useChatTurnStore.getState().setUserText(text),
  markTurnStarted: (opts) => useChatTurnStore.getState().markTurnStarted(opts),
  appendAssistantDelta: (delta) => useChatTurnStore.getState().appendAssistantDelta(delta),
  completeAssistant: (text) => useChatTurnStore.getState().completeAssistant(text),
  failAssistant: (message) => useChatTurnStore.getState().failAssistant(message),
  abortAssistant: () => useChatTurnStore.getState().abortAssistant(),
  appendReasoning: (delta) => useChatTurnStore.getState().appendReasoning(delta),
  endReasoning: (summary) => useChatTurnStore.getState().endReasoning(summary),
  addStep: (kind, callId, title, meta) =>
    useChatTurnStore.getState().addStep(kind, callId, title, meta),
  appendStep: (callId, text) => useChatTurnStore.getState().appendStep(callId, text),
  endStep: (callId, patch) => useChatTurnStore.getState().endStep(callId, patch),
  addInfo: (title, body) => useChatTurnStore.getState().addInfo(title, body),
  completeTurn: (opts) => useChatTurnStore.getState().completeTurn(opts),
  loadFromHistory: (items) => useChatTurnStore.getState().loadFromHistory(items),
  loadSnapshot: (history, events) => useChatTurnStore.getState().loadSnapshot(history, events),
  deriveWorkingState: (turnId) => useChatTurnStore.getState().deriveWorkingState(turnId)
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as any).__chatTurnStore = useChatTurnStore
  ;(window as any).__chatTurnActions = chatTurnActions
}
