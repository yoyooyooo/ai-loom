import type { ChatTurnStore, ChatTurnStoreCreator, ConvSlice, Turn, TurnStep } from './chat-turns.types'
import { createId } from '@/lib/id'
import { STAGING_CID } from './chat-turns-core'
import {
  buildReadStepParts,
  buildListStepParts,
  buildSearchStepParts
} from '@/features/codex-chat/services/ws-step-builders'
import { parseExploreActions } from '@/features/codex-chat/utils/explore-utils'

type EnrichedStep = TurnStep & { meta: Record<string, unknown> | null | undefined }

function createStepId(base?: string, suffix?: number | string) {
  if (!base) return createId('step')
  return suffix != null ? `${base}:${suffix}` : base
}

function enrichExecStep(step: any): EnrichedStep[] {
  const meta = step?.meta
  const commandRaw = meta?.command
  if (!Array.isArray(commandRaw) || commandRaw.length === 0) return [step]
  const command = commandRaw.map((c: any) => String(c))
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : undefined
  const actions = parseExploreActions(command, cwd)
  if (!Array.isArray(actions) || actions.length === 0) return [step]
  const callId =
    (typeof meta?.callId === 'string' && meta.callId) ||
    (typeof step?.id === 'string' && step.id) ||
    createId('exec')
  const ctx = { command, cwd, callId }
  const status = typeof step?.status === 'string' ? step.status : 'completed'
  const ts = typeof step?.ts === 'string' ? step.ts : step?.ts ?? null
  const exitCode = meta?.exitCode
  const stdout = meta?.stdout
  const stderr = meta?.stderr
  const out: EnrichedStep[] = []
  let first = true
  let idx = 0
  for (const action of actions) {
    let built:
      | ReturnType<typeof buildReadStepParts>
      | ReturnType<typeof buildListStepParts>
      | ReturnType<typeof buildSearchStepParts>
      | null = null
    let kind: TurnStep['kind'] | null = null
    if (action.kind === 'read') {
      built = buildReadStepParts(action as any, ctx)
      kind = 'read'
    } else if (action.kind === 'list') {
      built = buildListStepParts(action as any, ctx)
      kind = 'list'
    } else if (action.kind === 'search') {
      built = buildSearchStepParts(action as any, ctx)
      kind = 'search'
    }
    if (!built || !kind) continue
    const metaPatch: Record<string, unknown> = { ...(built.meta || {}) }
    if (exitCode != null) metaPatch.exitCode = exitCode
    if (stdout != null) metaPatch.stdout = stdout
    if (stderr != null) metaPatch.stderr = stderr
    const newStep: EnrichedStep = {
      id: createStepId(step.id || callId, idx),
      kind,
      title: built.title,
      body: first ? (step.body ?? null) : null,
      tags: built.tags ?? null,
      status,
      ts,
      meta: metaPatch
    }
    out.push(newStep)
    first = false
    idx += 1
  }
  return out.length > 0 ? out : [step]
}

function enrichSteps(stepsInput: any[]): EnrichedStep[] {
  const steps = Array.isArray(stepsInput) ? stepsInput : []
  const out: EnrichedStep[] = []
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue
    if (step.kind === 'exec') {
      out.push(...enrichExecStep(step))
    } else {
      out.push(step as EnrichedStep)
    }
  }
  return out
}

type SnapshotCreator = ChatTurnStoreCreator<ChatTurnStoreCreator.Snapshot>

function createEmptySlice(): ConvSlice {
  return {
    turns: [],
    activeTurnId: undefined,
    pendingCompletionTurnId: undefined,
    nextSeq: 0,
    toolIndex: {},
    toolHistory: {},
    generating: false,
    lastAccess: Date.now(),
    turnIndex: {},
    streamingIndex: {}
  }
}

function unregisterSliceTurns(state: ChatTurnStore, cid: string, slice: ConvSlice | undefined) {
  if (!slice || !Array.isArray(slice.turns)) return
  if (state.turnLocator) {
    for (const turn of slice.turns) {
      if (turn?.id) delete state.turnLocator[turn.id]
    }
  }
  slice.turnIndex = {}
}

function assignTurnsToSlice(state: ChatTurnStore, cid: string, slice: ConvSlice, turns: Turn[]) {
  slice.turns = turns
  slice.turnIndex = {}
  if (!(slice as any).toolHistory) (slice as any).toolHistory = {}
  const history = slice.toolHistory
  slice.pendingCompletionTurnId = undefined
  for (const key of Object.keys(history)) delete history[key]
  if (!state.turnLocator) state.turnLocator = {}
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]
    if (cid !== STAGING_CID && turn.conversationId !== cid) {
      ;(turn as any).conversationId = cid
    }
    slice.turnIndex[turn.id] = i
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

function bumpVersion(state: ChatTurnStore) {
  state.version = (state.version || 0) + 1
}

export function createSnapshotSlice(
  set: Parameters<SnapshotCreator>[0],
  get: Parameters<SnapshotCreator>[1]
): ReturnType<SnapshotCreator> {
  return {
    // 新增：从后端预组装的 turns 快照加载（优先路径）
    loadServerTurns(turnsInput: any[]) {
      const state = get()
      const cid = state.__eventCid || state.conversationId
      const key = cid ?? STAGING_CID
      const turns = Array.isArray(turnsInput) ? turnsInput : []
      set(
        (s) => {
          const by = s.byConv || (s.byConv = {})
          const conv = by[key] || (by[key] = createEmptySlice())
          unregisterSliceTurns(s, key, conv)
          // 正常化：确保每个 turn 带 conversationId
          const normalized = turns.map((t: any, idx: number) => {
            const id = typeof t?.id === 'string' && t.id ? t.id : `turn-server_${idx + 1}`
            const seq = typeof t?.seq === 'number' ? t.seq : idx + 1
            const convId = cid || t?.conversationId
            const status = typeof t?.status === 'string' ? t.status : 'completed'
            const user = t?.user && typeof t.user.text === 'string' ? t.user : undefined
            const assistant =
              t?.assistant && typeof t.assistant.text === 'string' ? t.assistant : undefined
            const reasoning =
              t?.reasoning && typeof t.reasoning === 'object' ? t.reasoning : undefined
            const rawSteps = Array.isArray(t?.steps) ? t.steps : []
            const steps = enrichSteps(rawSteps)
            return { id, seq, conversationId: convId, status, user, assistant, reasoning, steps }
          })
          assignTurnsToSlice(s, key, conv, normalized as any)
          conv.activeTurnId = undefined
          conv.pendingCompletionTurnId = undefined
          conv.nextSeq =
            normalized.length > 0 ? Math.max(...normalized.map((x: any) => x.seq || 0)) : 0
          conv.toolIndex = {}
          conv.generating = false
          conv.lastAccess = Date.now()
          bumpVersion(s)
        },
        false,
        'turns/loadServerTurns'
      )
    }
  }
}
