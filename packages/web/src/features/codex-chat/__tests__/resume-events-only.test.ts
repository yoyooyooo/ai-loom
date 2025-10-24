import { describe, it, beforeEach, expect } from 'vitest'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'

describe('resume events-only → turns with steps', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })

  it('builds turns and exec steps from chat.* events without history', () => {
    const events = [
      { method: 'chat.turn.started', params: { turnSeq: 1 } },
      { method: 'chat.info.user_message', params: { text: 'echo version' } },
      { method: 'chat.tool.exec.begin', params: { callId: 'call_1', cwd: '/tmp', command: ['bash', '-lc', 'echo ok'] } },
      { method: 'chat.tool.exec.output', params: { callId: 'call_1', stream: 'stdout', text: 'ok\n' } },
      { method: 'chat.tool.exec.end', params: { callId: 'call_1', exitCode: 0, stdout: 'ok\n' } },
      { method: 'chat.message.completed', params: { text: '完成' } },
      { method: 'chat.turn.complete', params: {} }
    ]

    chatTurnActions.loadSnapshot([], events)

    const state = useChatTurnStore.getState()
    expect(state.turns.length).toBeGreaterThan(0)
    const t0 = state.turns[0]
    expect(t0.user.text).toBe('echo version')
    expect(t0.assistant.text.length).toBeGreaterThan(0)
    expect(t0.steps.length).toBeGreaterThan(0)
    const exec = t0.steps.find((s) => s.kind === 'exec')
    expect(exec).toBeTruthy()
    expect(exec?.status).toBe('completed')
    expect((exec?.meta as any)?.exitCode).toBe(0)
  })
})

