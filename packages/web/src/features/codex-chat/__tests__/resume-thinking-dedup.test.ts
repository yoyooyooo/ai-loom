import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'

describe('resume events thinking dedup', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('adds only one thinking step when multiple reasoning.end with same body', () => {
    const events = [
      { method: 'chat.turn.started', params: { turnSeq: 1 } },
      { method: 'chat.reasoning.end', params: { text: 'Title\n\nDetailed content.' } },
      { method: 'chat.reasoning.end', params: { text: 'Title\n\nDetailed content.' } },
      { method: 'chat.message.completed', params: { text: 'answer' } },
      { method: 'chat.turn.complete', params: { turnSeq: 1 } }
    ]
    chatTurnActions.loadSnapshot([], events as any)
    const t = useChatTurnStore.getState().turns[0]
    const think = t.steps.filter((s) => s.kind === 'thinking')
    expect(think.length).toBe(1)
    expect(think[0]?.title?.toLowerCase()).toContain('thinking')
  })
})

