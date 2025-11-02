import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'

describe('UI：thinking 步骤去重（Resume 构建路径）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })
  afterEach(() => {
    chatTurnActions.reset()
  })

  it('loadServerTurns：thinking 步骤可被 UI 渲染', async () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'hi', ts: '' },
        assistant: { text: 'ok' },
        steps: [
          {
            id: 'th1',
            kind: 'thinking',
            title: 'thinking: Plan',
            status: 'completed',
            ts: '',
            body: 'Plan\n\nA\nB'
          },
          {
            id: 'ex1',
            kind: 'exec',
            title: 'echo ok',
            status: 'completed',
            ts: '',
            meta: { command: ['bash', '-lc', 'echo ok'] },
            body: 'ok'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const st = useChatTurnStore.getState()
    const t = chatTurnSelectors.currentSlice(st).turns[0]
    expect(t.steps.filter((s) => s.kind === 'thinking').length).toBe(1)
  })
})
