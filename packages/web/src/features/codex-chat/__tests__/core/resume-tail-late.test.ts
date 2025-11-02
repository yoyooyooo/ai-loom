import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import tailLate from '../fixtures/resume-events-tail-late.json'

describe('resume events with tool.end arriving after message.completed (same turnSeq)', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('keeps single turn and aggregates exec step as completed', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'hi', ts: '' },
        assistant: { text: 'done' },
        steps: [
          {
            id: 's1',
            kind: 'exec',
            title: 'echo ok',
            status: 'completed',
            ts: '',
            meta: { command: ['bash', '-lc', 'echo ok'], exitCode: 0 },
            body: 'ok'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const st = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(st)
    expect(slice.turns).toHaveLength(1)
    const t = slice.turns[0]
    expect(t.assistant.text).toBe('done')
    const exec = t.steps.find((s) => s.kind === 'exec')
    expect(exec).toBeTruthy()
    expect(exec?.status).toBe('completed')
    const d = st.deriveWorkingState(t.id)
    expect(d.working).toBe(false)
    expect(d.workingTitle).toBe('Finished working')
  })
})
