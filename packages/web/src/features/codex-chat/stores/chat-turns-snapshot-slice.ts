import type { Turn, TurnStep } from './chat-turns'
import { createId } from '@/lib/id'
import { buildTurnsFromHistory as buildTurnsFromHistoryExternal, applyEventsToTurns as applyEventsToTurnsExternal } from './chat-turns-snapshot'
import { summarizeFirstLine, nowISO } from './chat-turns-utils'

export function createSnapshotSlice(set: any, get: any) {
  return {
    loadFromHistory(items: Array<{ role: 'user' | 'assistant' | 'reasoning'; text: string; reasoning?: string | null }>) {
      const state = get()
      const { turns, nextSeq } = buildTurnsFromHistoryExternal(items as any, state.conversationId)
      set(
        { ...state, turns, activeTurnId: undefined, nextSeq, toolIndex: {}, generating: false },
        false,
        'turns/loadFromHistory'
      )
    },

    loadSnapshot(
      history: Array<{ role: 'user' | 'assistant' | 'reasoning'; text: string; reasoning?: string | null }>,
      events: Array<{ method: string; params?: Record<string, any> | null | undefined }>
    ) {
      const state = get()
      let baseTurns: Turn[] = []
      let nextSeq = 0
      if (Array.isArray(history) && history.length > 0) {
        const built = buildTurnsFromHistoryExternal(history as any, state.conversationId)
        baseTurns = built.turns
        nextSeq = built.nextSeq
      }
      applyEventsToTurnsExternal(baseTurns as any, events as any)
      if (nextSeq === 0 && baseTurns.length > 0) {
        nextSeq = Math.max(...baseTurns.map((t) => t.seq))
      }
      // Fallback：若该 turn 有 reasoning 且已有其它步骤，但缺少 thinking 步骤，则补一条（保证 Working 内可见）
      for (const turn of baseTurns) {
        const hasReasoning = !!(turn.reasoning?.content || '').trim()
        const hasSteps = Array.isArray(turn.steps) && turn.steps.length > 0
        const hasThinking = hasSteps && turn.steps.some((s) => s.kind === 'thinking')
        if (hasReasoning && hasSteps && !hasThinking) {
          const title = summarizeFirstLine(turn.reasoning!.content)
          turn.steps.push({
            id: createId('thinking'),
            kind: 'thinking',
            title: title ? `thinking: ${title}` : 'thinking',
            body: turn.reasoning!.content,
            status: 'completed',
            ts: nowISO(),
            meta: { thinking: true }
          } as TurnStep)
        }
      }
      // 归一化：去重 thinking 步骤
      for (const turn of baseTurns) {
        if (!Array.isArray(turn.steps) || turn.steps.length === 0) continue
        const seen = new Set<string>()
        const deduped: TurnStep[] = []
        for (const step of turn.steps) {
          if (step.kind !== 'thinking') { deduped.push(step); continue }
          const key = ((step.body || step.title || '').trim() || '').slice(0, 2048)
          if (!key) continue
          if (seen.has(key)) continue
          seen.add(key)
          deduped.push(step)
        }
        turn.steps = deduped
      }
      set(
        { ...state, turns: baseTurns, activeTurnId: undefined, nextSeq, toolIndex: {}, generating: false },
        false,
        'turns/loadSnapshot'
      )
    }
  }
}
