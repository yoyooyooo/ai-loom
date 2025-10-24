import { createId } from '@/lib/id'

function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first.replace(/^[\s#>*_`]+/, '').replace(/[\s#*_`]+$/, '').trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

function nowISO() {
  return new Date().toISOString()
}

function calcGenerating(state: { turns: any[] }): boolean {
  return state.turns.some((turn) => {
    if (turn.status === 'streaming') return true
    return Array.isArray(turn.steps) && turn.steps.some((step: any) => step.status === 'streaming')
  })
}

function createStreamingTurn(state: any, userText?: string) {
  const seq = (state.nextSeq ?? 0) + 1
  const ts = nowISO()
  return {
    id: createId('turn'),
    seq,
    conversationId: state.conversationId,
    startedAt: ts,
    status: 'streaming',
    user: { text: userText ?? '', ts },
    assistant: { text: '' },
    reasoning: undefined,
    steps: [],
    meta: { working: true, workingTitle: 'Working' }
  }
}

function ensureTurnReasoning(turn: any) {
  if (turn.reasoning) return turn.reasoning
  const empty = { content: '' }
  turn.reasoning = empty
  return empty
}

function mergeStepBody(prev: string | undefined, next: string): string {
  if (!prev) return next
  if (!next) return prev
  return prev.length === 0 ? next : `${prev}${prev.endsWith('\n') ? '' : '\n'}${next}`
}

export function createCoreSlice(set: any, get: any) {
  return {
    conversationId: undefined as string | undefined,
    turns: [] as any[],
    activeTurnId: undefined as string | undefined,
    nextSeq: 0,
    toolIndex: {} as Record<string, { turnId: string; stepId: string }>,
    generating: false,

    setConversationId(id?: string) {
      set((state: any) => {
        try {
          if (typeof window !== 'undefined') {
            if (id) localStorage.setItem('chat.conversationId', id)
            else localStorage.removeItem('chat.conversationId')
          }
        } catch {}
        return { ...state, conversationId: id }
      }, false, 'turns/setConversationId')
    },

    reset() {
      set(
        {
          conversationId: undefined,
          turns: [],
          activeTurnId: undefined,
          nextSeq: 0,
          toolIndex: {},
          generating: false
        },
        false,
        'turns/reset'
      )
    },

    addUserTurn(text: string) {
      const trimmed = String(text ?? '')
      const id = createId('turn')
      const ts = nowISO()
      set((state: any) => {
        const seq = (state.nextSeq ?? 0) + 1
        const turn = {
          id,
          seq,
          conversationId: state.conversationId,
          startedAt: ts,
          status: 'streaming',
          user: { text: trimmed, ts },
          assistant: { text: '' },
          steps: [],
          meta: { working: true, workingTitle: 'Working' }
        }
        return {
          ...state,
          turns: state.turns.concat(turn),
          activeTurnId: id,
          nextSeq: seq,
          generating: true
        }
      }, false, 'turns/addUserTurn')
      return id
    },

    setUserText(text?: string) {
      const trimmed = String(text ?? '')
      if (!trimmed) return
      set((state: any) => {
        let targetId = state.activeTurnId
        let turns = state.turns as any[]
        if (!targetId || !turns.some((t) => t.id === targetId && t.status === 'streaming')) {
          const existing = [...turns].reverse().find((t) => t.status === 'streaming')
          if (existing) {
            targetId = existing.id
          } else {
            const turn = createStreamingTurn(state, trimmed)
            turns = turns.concat(turn)
            targetId = turn.id
          }
        }
        const ts = nowISO()
        const nextTurns = turns.map((turn) =>
          turn.id === targetId ? { ...turn, user: { text: trimmed, ts }, meta: { ...(turn.meta || {}), working: true, workingTitle: 'Working' } } : turn
        )
        return {
          ...state,
          turns: nextTurns,
          activeTurnId: targetId,
          generating: calcGenerating({ turns: nextTurns }),
          nextSeq: Math.max(state.nextSeq ?? 0, ...nextTurns.map((t: any) => t.seq))
        }
      }, false, 'turns/setUserText')
    },

    markTurnStarted(opts?: { startedAt?: string }) {
      const ts = opts?.startedAt ?? nowISO()
      let ensuredId = ''
      set((state: any) => {
        let targetId = state.activeTurnId
        let turns = state.turns as any[]
        if (!targetId || !turns.some((t) => t.id === targetId && t.status === 'streaming')) {
          const existing = [...turns].reverse().find((t) => t.status === 'streaming')
          if (existing) {
            targetId = existing.id
          } else {
            const turn = createStreamingTurn(state)
            turns = turns.concat(turn)
            targetId = turn.id
          }
        }
        ensuredId = targetId
        const nextTurns = turns.map((turn) =>
          turn.id === targetId ? { ...turn, startedAt: ts, meta: { ...(turn.meta || {}), working: true, workingTitle: 'Working' } } : turn
        )
        return {
          ...state,
          turns: nextTurns,
          activeTurnId: targetId,
          generating: true,
          nextSeq: Math.max(state.nextSeq ?? 0, ...nextTurns.map((t: any) => t.seq))
        }
      }, false, 'turns/markTurnStarted')
      return ensuredId
    },

    appendAssistantDelta(delta?: string) {
      if (!delta) return
      set((state: any) => {
        let targetId = state.activeTurnId
        let turns = state.turns as any[]
        if (!targetId || !turns.some((t) => t.id === targetId && t.status === 'streaming')) {
          const existing = [...turns].reverse().find((t) => t.status === 'streaming')
          if (existing) {
            targetId = existing.id
          } else {
            return state
          }
        }
        const nextTurns = turns.map((turn) => {
          if (turn.id !== targetId) return turn
          const assistantText = (turn.assistant?.text || '') + delta
          return { ...turn, assistant: { ...(turn.assistant || { text: '' }), text: assistantText }, status: 'streaming' }
        })
        return { ...state, turns: nextTurns, activeTurnId: targetId, generating: true, nextSeq: Math.max(state.nextSeq ?? 0, ...nextTurns.map((t: any) => t.seq)) }
      }, false, 'turns/appendAssistantDelta')
    },

    completeAssistant(text?: string) {
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== targetId) return turn
          const finalText = typeof text === 'string' ? text : turn.assistant.text
          const status = turn.status === 'failed' || turn.status === 'aborted' ? turn.status : 'completed'
          const hasStreamingSteps = Array.isArray(turn.steps) && turn.steps.some((s: any) => s.status === 'streaming')
          return { ...turn, assistant: { text: finalText ?? '', ts: nowISO() }, status, meta: { ...(turn.meta || {}), working: hasStreamingSteps, workingTitle: hasStreamingSteps ? 'Working' : 'Finished working' } }
        })
        return { ...state, turns: nextTurns, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/completeAssistant')
    },

    failAssistant(message?: string) {
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const nextTurns = state.turns.map((turn: any) => (turn.id === targetId ? { ...turn, assistant: { text: message ? String(message) : turn.assistant.text, ts: nowISO() }, status: 'failed', meta: { ...(turn.meta || {}), working: false, workingTitle: 'Failed' } } : turn))
        return { ...state, turns: nextTurns, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/failAssistant')
    },

    abortAssistant() {
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const nextTurns = state.turns.map((turn: any) => (turn.id === targetId ? { ...turn, status: 'aborted', meta: { ...(turn.meta || {}), working: false, workingTitle: 'Aborted' }, assistant: { text: turn.assistant.text, ts: nowISO() } } : turn))
        return { ...state, turns: nextTurns, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/abortAssistant')
    },

    appendReasoning(delta?: string) {
      if (!delta) return
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== targetId) return turn
          const reasoning = ensureTurnReasoning(turn)
          reasoning.content = (reasoning.content || '') + delta
          return { ...turn, reasoning, status: 'streaming' }
        })
        return { ...state, turns: nextTurns, generating: true }
      }, false, 'turns/appendReasoning')
    },

    endReasoning(summary?: string) {
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const content = String(summary ?? '')
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== targetId) return turn
          if (!content.trim()) {
            if (!turn.reasoning) return turn
            return { ...turn, reasoning: { ...turn.reasoning, title: summarizeFirstLine(turn.reasoning.content), content: turn.reasoning.content } }
          }
          return { ...turn, reasoning: { content, title: summarizeFirstLine(content) } }
        })
        return { ...state, turns: nextTurns, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/endReasoning')
    },

    addStep(kind: any, callId: string | undefined, title: string, options?: { meta?: any; tags?: string[]; status?: any; body?: string }) {
      const detailId = createId(kind)
      const ts = nowISO()
      set((state: any) => {
        if (callId && state.toolIndex[callId]) {
          return state
        }
        let targetId = state.activeTurnId
        let turns = state.turns as any[]
        if (!targetId || !turns.some((t) => t.id === targetId)) {
          const fallback = [...turns].reverse().find((t) => t.status === 'streaming') ?? turns[turns.length - 1]
          if (!fallback) return state
          targetId = fallback.id
        }
        const stepStatus = options?.status ?? 'streaming'
        const nextTurns = turns.map((turn) => {
          if (turn.id !== targetId) return turn
          const step = {
            id: detailId,
            kind,
            title: title || `[${kind}]`,
            body: options?.body ?? '',
            status: stepStatus,
            ts,
            tags: options?.tags,
            meta: options?.meta
          }
          const hasStreaming = stepStatus === 'streaming' || (turn.steps || []).some((existing: any) => existing.status === 'streaming')
          const workingTitle = hasStreaming ? 'Working' : turn.meta?.workingTitle ?? 'Finished working'
          return { ...turn, steps: (turn.steps || []).concat(step), meta: { ...(turn.meta || {}), working: hasStreaming, workingTitle } }
        })
        const nextToolIndex = { ...(state.toolIndex || {}) }
        if (callId) nextToolIndex[callId] = { turnId: targetId, stepId: detailId }
        return { ...state, turns: nextTurns, toolIndex: nextToolIndex, activeTurnId: targetId, generating: true }
      }, false, 'turns/addStep')
      return detailId
    },

    appendStep(callId: string, text: string) {
      if (!callId || !text) return
      set((state: any) => {
        const entry = state.toolIndex[callId]
        if (!entry) return state
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== entry.turnId) return turn
          const steps = (turn.steps || []).map((step: any) => (step.id === entry.stepId ? { ...step, body: mergeStepBody(step.body, text) } : step))
          return { ...turn, steps }
        })
        return { ...state, turns: nextTurns, generating: true }
      }, false, 'turns/appendStep')
    },

    endStep(callId: string, patch?: any) {
      if (!callId) return
      set((state: any) => {
        const entry = state.toolIndex[callId]
        if (!entry) return state
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== entry.turnId) return turn
          const steps = (turn.steps || []).map((step: any) =>
            step.id === entry.stepId ? { ...step, status: (patch?.status ?? 'completed'), body: patch?.body ?? step.body, meta: patch?.meta ? { ...(step.meta || {}), ...patch.meta } : step.meta } : step
          )
        
          return { ...turn, steps, meta: { ...(turn.meta || {}), working: steps.some((s: any) => s.status === 'streaming'), workingTitle: steps.some((s: any) => s.status === 'streaming') ? 'Working' : 'Finished working' } }
        })
        const { [callId]: _removed, ...rest } = state.toolIndex
        return { ...state, turns: nextTurns, toolIndex: rest, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/endStep')
    },

    addInfo(title: string, body?: string) {
      const ts = nowISO()
      set((state: any) => {
        let targetId = state.activeTurnId
        let turns = state.turns as any[]
        if (!targetId || !turns.some((t) => t.id === targetId)) {
          const fallback = [...turns].reverse().find((t) => t.status === 'streaming') ?? turns[turns.length - 1]
          if (!fallback) return state
          targetId = fallback.id
        }
        const nextTurns = turns.map((turn) => {
          if (turn.id !== targetId) return turn
          const step = { id: createId('info'), kind: 'info', title, body, status: 'completed', ts }
          return { ...turn, steps: (turn.steps || []).concat(step), meta: { ...(turn.meta || {}) } }
        })
        return { ...state, turns: nextTurns, activeTurnId: targetId, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/addInfo')
    },

    completeTurn(opts?: { completedAt?: string }) {
      const completedAt = opts?.completedAt ?? nowISO()
      set((state: any) => {
        const targetId = state.activeTurnId
        if (!targetId) return state
        const nextTurns = state.turns.map((turn: any) => {
          if (turn.id !== targetId) return turn
          const status = turn.status === 'failed' || turn.status === 'aborted' ? turn.status : 'completed'
          const hasStreamingSteps = Array.isArray(turn.steps) && turn.steps.some((step: any) => step.status === 'streaming')
          let workingTitle = turn.meta?.workingTitle
          if (status === 'failed') workingTitle = 'Failed'
          else if (status === 'aborted') workingTitle = 'Aborted'
          else if (!workingTitle) workingTitle = hasStreamingSteps ? 'Working' : 'Finished working'
          return { ...turn, status, completedAt, meta: { ...(turn.meta || {}), working: hasStreamingSteps, workingTitle } }
        })
        const cleanedIndex = Object.fromEntries(Object.entries(state.toolIndex).filter(([, v]: any) => v?.turnId !== targetId)) as Record<string, { turnId: string; stepId: string }>
        return { ...state, turns: nextTurns, activeTurnId: undefined, toolIndex: cleanedIndex, generating: calcGenerating({ turns: nextTurns }) }
      }, false, 'turns/completeTurn')
    },

    deriveWorkingState(turnId: string) {
      const state = get()
      const turn = state.turns.find((t: any) => t.id === turnId)
      if (!turn) {
        return { working: false, detailsCount: 0, workingTitle: 'Finished working' }
      }
      const working = turn.meta?.working ?? turn.steps.some((step: any) => step.status === 'streaming')
      const detailsCount = turn.steps.length
      const workingTitle = turn.meta?.workingTitle ?? (working ? 'Working' : 'Finished working')
      return { working, detailsCount, workingTitle }
    }
  }
}

