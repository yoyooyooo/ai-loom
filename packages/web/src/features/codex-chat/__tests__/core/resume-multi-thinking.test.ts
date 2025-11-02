import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

describe('resume events with multiple distinct thinking in one turn', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('server turns: multiple thinking steps are preserved（服务端可自行去重）', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'final answer' },
        steps: [
          {
            id: 'th1',
            kind: 'thinking',
            title: 'thinking: Title A',
            status: 'completed',
            ts: '',
            body: 'Title A\n\nDetails A'
          },
          {
            id: 'th2',
            kind: 'thinking',
            title: 'thinking: Title B',
            status: 'completed',
            ts: '',
            body: 'Title B\n\nDetails B'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const think = t.steps.filter((s) => s.kind === 'thinking')
    expect(think.length).toBe(2)
  })
})
