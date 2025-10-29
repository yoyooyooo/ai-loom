import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

describe('UI：thinking 步骤去重（Resume 构建路径）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })
  afterEach(() => {
    chatTurnActions.reset()
  })

  it('loadSnapshot(events 含重复 reasoning.end) 后仅保留一个 thinking 步骤（供 UI 渲染）', async () => {
    const history: Array<{ role: any; text: string }> = [{ role: 'user', text: 'hi' }]
    const events = [
      { method: 'chat.reasoning.end', params: { text: 'Plan\n\nA\nB' } },
      { method: 'chat.reasoning.end', params: { text: 'Plan\n\nA\nB' } },
      { method: 'chat.tool.exec.begin', params: { callId: 'c1', command: ['bash', '-lc', 'echo ok'] } },
      { method: 'chat.message.completed', params: { text: 'ok' } },
      { method: 'chat.turn.complete', params: {} }
    ]
    chatTurnActions.loadSnapshot(history as any, events as any)
    const st = useChatTurnStore.getState()
    const t = st.turns[0]
    expect(t.steps.filter((s) => s.kind === 'thinking').length).toBe(1)
  })
})
