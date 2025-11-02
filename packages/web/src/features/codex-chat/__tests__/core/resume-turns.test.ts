import { describe, it, beforeEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
describe('resume pipeline to turns (server turns)', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })

  it('hydrates events into turn steps', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        conversationId: 'conv-x',
        status: 'completed',
        user: { text: 'hi', ts: '' },
        assistant: { text: 'done' },
        steps: [
          {
            id: 's1',
            kind: 'exec',
            title: 'echo hi',
            status: 'completed',
            ts: '',
            meta: { command: ['bash', '-lc', 'echo hi'] },
            body: 'hi\n'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)

    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBeGreaterThan(0)
    const withSteps = slice.turns.find((turn) => turn.steps.length > 0)
    expect(withSteps).toBeTruthy()
    const execStep = withSteps?.steps.find((step) => step.kind === 'exec')
    expect(execStep).toBeTruthy()
    expect(execStep?.status).toBe('completed')
    expect(execStep?.body && execStep.body.length).toBeGreaterThan(0)

    // 其他步骤（patch/mcp/info）按实际会话可能不存在，这里不强制要求
  })

  it('is idempotent when loadServerTurns called twice', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        conversationId: 'conv-x',
        status: 'completed',
        user: { text: 'hi', ts: '' },
        assistant: { text: 'done' },
        steps: [
          {
            id: 's1',
            kind: 'exec',
            title: 'echo hi',
            status: 'completed',
            ts: '',
            meta: { command: ['bash', '-lc', 'echo hi'] },
            body: 'hi\n'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const once = chatTurnSelectors
      .currentTurns(useChatTurnStore.getState())
      .map((turn) => turn.steps.length)

    chatTurnActions.loadServerTurns(turns as any)
    const twice = chatTurnSelectors
      .currentTurns(useChatTurnStore.getState())
      .map((turn) => turn.steps.length)

    expect(twice).toEqual(once)
  })
})
