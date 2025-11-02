import type { StateCreator } from 'zustand'
import type {
  Turn as GeneratedTurn,
  TurnAssistant as GeneratedTurnAssistant,
  TurnReasoning as GeneratedTurnReasoning,
  TurnStatus as GeneratedTurnStatus,
  TurnStep as GeneratedTurnStep,
  TurnStepKind as GeneratedTurnStepKind,
  TurnStepStatus as GeneratedTurnStepStatus,
  TurnUser as GeneratedTurnUser
} from '../types/generated/turns'

export type TurnStepKind = GeneratedTurnStepKind
export type TurnStepStatus = GeneratedTurnStepStatus
export type TurnStatus = GeneratedTurnStatus
export type TurnStep = GeneratedTurnStep
export type TurnReasoning = GeneratedTurnReasoning
export type TurnAssistant = GeneratedTurnAssistant
export type TurnUser = GeneratedTurnUser
export type Turn = GeneratedTurn

export type ConvSlice = {
  turns: Turn[]
  activeTurnId?: string
  nextSeq: number
  toolIndex: Record<string, { turnId: string; stepId: string }>
  toolHistory: Record<string, { turnId: string; stepId: string }>
  generating: boolean
  lastAccess?: number
  turnIndex: Record<string, number>
  streamingIndex?: Record<string, boolean>
}

export type TurnStoreState = {
  conversationId?: string
  byConv: Record<string, ConvSlice>
  __eventCid?: string
  turnLocator: Record<string, { conversationId: string }>
  version: number
  // 路由处于新建页（/chat）等场景时，禁止 WS 自动切换会话
  wsAutoSelectGuard?: boolean
}

export type TurnStoreActions = {
  setConversationId: (id: string | undefined) => void
  setWsAutoSelectGuard: (enabled: boolean) => void
  reset: () => void
  __beginFor: (cid?: string) => void
  __endEvent: () => void
  addUserTurn: (text: string) => string
  setUserText: (text: string) => void
  markTurnStarted: (opts?: { startedAt?: string }) => string
  appendAssistantDelta: (delta: string) => void
  completeAssistant: (text?: string, ts?: string, eventId?: number) => void
  failAssistant: (message?: string) => void
  abortAssistant: () => void
  appendReasoning: (delta: string) => void
  endReasoning: (summary: string) => void
  markFinalMessageStarted: () => void
  unmarkFinalMessageStarted: () => void
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
  loadServerTurns: (turns: Turn[]) => void
  deriveWorkingState: (turnId: string) => {
    working: boolean
    detailsCount: number
    workingTitle: string
  }
  getLastAssistantPreview: (conversationId: string, max?: number) => string | null
}

export type ChatTurnStore = TurnStoreState & TurnStoreActions

export type ChatTurnCoreSlice = TurnStoreState & Omit<TurnStoreActions, 'loadServerTurns'>

export type ChatTurnSnapshotSlice = Pick<TurnStoreActions, 'loadServerTurns'>

export type ChatTurnStoreCreator<TSlice> = StateCreator<
  ChatTurnStore,
  [['zustand/devtools', never], ['zustand/immer', never]],
  [],
  TSlice
>

export namespace ChatTurnStoreCreator {
  export type Core = ChatTurnCoreSlice
  export type Snapshot = ChatTurnSnapshotSlice
}
