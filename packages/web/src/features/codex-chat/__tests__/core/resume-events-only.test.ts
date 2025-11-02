import { describe, it, beforeEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

describe('resume events-only → turns with steps', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })

  it('loadServerTurns: builds turns with exec steps from server turns', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        conversationId: 'conv-x',
        status: 'completed',
        user: { text: 'echo version', ts: '' },
        assistant: { text: '完成' },
        steps: [
          {
            id: 's1',
            kind: 'exec',
            title: 'bash -lc echo ok',
            status: 'completed',
            ts: '',
            meta: {
              callId: 'call_1',
              cwd: '/tmp',
              command: ['bash', '-lc', 'echo ok'],
              exitCode: 0,
              stdout: 'ok\n'
            },
            body: 'ok\n'
          }
        ]
      }
    ]

    chatTurnActions.loadServerTurns(turns as any)

    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBeGreaterThan(0)
    const t0 = slice.turns[0]
    expect(t0.user.text).toBe('echo version')
    expect(t0.assistant.text.length).toBeGreaterThan(0)
    expect(t0.steps.length).toBeGreaterThan(0)
    const exec = t0.steps.find((s) => s.kind === 'exec')
    expect(exec).toBeTruthy()
    expect(exec?.status).toBe('completed')
    expect((exec?.meta as any)?.exitCode).toBe(0)
  })
})
