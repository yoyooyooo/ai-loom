import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

describe('resume events thinking dedup', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('thinking step provided by server turns', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'hi', ts: '' },
        assistant: { text: 'answer' },
        steps: [
          {
            id: 'th1',
            kind: 'thinking',
            title: 'thinking: Title',
            status: 'completed',
            ts: '',
            body: 'Title\n\nDetailed content.'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const think = t.steps.find((s) => s.kind === 'thinking')
    expect(think).toBeTruthy()
    expect(think?.title?.toLowerCase()).toContain('thinking')
  })
})
