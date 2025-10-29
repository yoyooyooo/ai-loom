import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'
import tailLate from '../fixtures/resume-events-tail-late.json'

describe('resume events with tool.end arriving after message.completed (same turnSeq)', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('keeps single turn and aggregates exec step as completed', () => {
    chatTurnActions.loadSnapshot([], (tailLate as any).events)
    const st = useChatTurnStore.getState()
    expect(st.turns).toHaveLength(1)
    const t = st.turns[0]
    expect(t.assistant.text).toBe('done')
    const exec = t.steps.find((s) => s.kind === 'exec')
    expect(exec).toBeTruthy()
    expect(exec?.status).toBe('completed')
    const d = st.deriveWorkingState(t.id)
    expect(d.working).toBe(false)
    expect(d.workingTitle).toBe('Finished working')
  })
})
