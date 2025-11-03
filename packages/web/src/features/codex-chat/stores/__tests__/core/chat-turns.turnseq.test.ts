import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'

function currentSlice() {
  return chatTurnSelectors.currentSlice(useChatTurnStore.getState())
}

describe('chat-turn store turnSeq handling', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })

  afterEach(() => {
    chatTurnActions.reset()
  })

  it('ignores chat.turn.started when the same seq is already completed', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        conversationId: 'conv-1',
        status: 'completed',
        user: { text: 'q', ts: '2025-01-01T00:00:00Z' },
        assistant: { text: 'a', ts: '2025-01-01T00:00:01Z' },
        steps: []
      }
    ] as any)

    const before = currentSlice()
    expect(before.turns).toHaveLength(1)
    expect(before.activeTurnId).toBeUndefined()

    const result = chatTurnActions.markTurnStarted({ turnSeq: 1, startedAt: '2025-01-01T00:00:02Z' })
    expect(result).toBe('')

    const after = currentSlice()
    expect(after.turns).toHaveLength(1)
    expect(after.turns[0].seq).toBe(1)
    expect(after.turns[0].status).toBe('completed')
    expect(after.activeTurnId).toBeUndefined()
  })

  it('reuses the existing streaming turn when turnSeq matches', () => {
    const firstId = chatTurnActions.markTurnStarted({ turnSeq: 1, startedAt: '2025-01-01T00:00:00Z' })
    expect(firstId).toMatch(/^turn_/)

    const secondId = chatTurnActions.markTurnStarted({ turnSeq: 1, startedAt: '2025-01-01T00:00:01Z' })
    expect(secondId).toBe(firstId)

    const slice = currentSlice()
    expect(slice.turns).toHaveLength(1)
    expect(slice.turns[0].seq).toBe(1)
    expect(slice.turns[0].status).toBe('streaming')
    expect(slice.activeTurnId).toBe(firstId)
  })

  it('creates a new turn when receiving a higher turnSeq', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        conversationId: 'conv-1',
        status: 'completed',
        user: { text: 'hello', ts: '2025-01-01T00:00:00Z' },
        assistant: { text: 'hi', ts: '2025-01-01T00:00:01Z' },
        steps: []
      }
    ] as any)

    const newId = chatTurnActions.markTurnStarted({ turnSeq: 2, startedAt: '2025-01-01T00:01:00Z' })
    expect(newId).toMatch(/^turn_/)

    const slice = currentSlice()
    expect(slice.turns).toHaveLength(2)
    const second = slice.turns[1]
    expect(second.seq).toBe(2)
    expect(second.status).toBe('streaming')
    expect(slice.activeTurnId).toBe(newId)
  })
})
