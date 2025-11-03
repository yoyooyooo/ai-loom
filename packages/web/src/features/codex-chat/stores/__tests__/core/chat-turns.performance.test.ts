import { performance } from 'node:perf_hooks'
import { beforeEach, describe, expect, it } from 'vitest'
import { chatTurnActions, chatTurnSelectors, useChatTurnStore } from '../../chat-turns'

describe('ChatTurnStore pressure scenarios', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })

  it('appendAssistantDelta handles thousands of deltas within budget', () => {
    chatTurnActions.setConversationId('perf-delta')
    chatTurnActions.addUserTurn('hello')
    chatTurnActions.markTurnStarted({})

    const iterations = 3000
    const start = performance.now()
    for (let i = 0; i < iterations; i += 1) {
      chatTurnActions.appendAssistantDelta('x')
    }
    const elapsed = performance.now() - start
    const slice = chatTurnSelectors.sliceById('perf-delta')(useChatTurnStore.getState())
    const turn = slice.turns.at(-1)!
    expect(turn.assistant.text.length).toBe(iterations)
    expect(elapsed).toBeLessThan(350) // 应在 350ms 内完成
  })

  it('工具步骤增量更新保持线性，并在阈值内完成', () => {
    chatTurnActions.setConversationId('perf-steps')
    chatTurnActions.addUserTurn('steps')
    chatTurnActions.markTurnStarted({})

    const operations = 300
    const start = performance.now()
    for (let i = 0; i < operations; i += 1) {
      const callId = `call-${i}`
      chatTurnActions.addStep('exec', callId, `cmd-${i}`, { status: 'streaming' })
      chatTurnActions.appendStep(callId, 'stdout chunk')
      chatTurnActions.endStep(callId, { status: 'completed', meta: { exitCode: 0 } })
    }
    const elapsed = performance.now() - start
    const slice = chatTurnSelectors.sliceById('perf-steps')(useChatTurnStore.getState())
    const turn = slice.turns.at(-1)!
    expect(turn.steps.length).toBe(operations)
    expect(turn.steps.every((step: any) => step.status === 'completed')).toBe(true)
    expect(elapsed).toBeLessThan(1300)
  })

  it('deriveWorkingState 直接命中 turnIndex 而非全局扫描', () => {
    const totalConvs = 120
    const turnsPerConv = 20
    for (let c = 0; c < totalConvs; c += 1) {
      const cid = `conv-${c}`
      chatTurnActions.setConversationId(cid)
      for (let t = 0; t < turnsPerConv; t += 1) {
        chatTurnActions.addUserTurn(`ask-${c}-${t}`)
        chatTurnActions.markTurnStarted({})
        chatTurnActions.appendAssistantDelta('reply')
        chatTurnActions.completeAssistant('reply')
        chatTurnActions.completeTurn()
      }
    }
    const anyState = useChatTurnStore.getState()
    const targetTurnId = chatTurnSelectors.sliceById('conv-119')(anyState).turns.at(-1)!.id

    const start = performance.now()
    for (let i = 0; i < 2000; i += 1) {
      const res = useChatTurnStore.getState().deriveWorkingState(targetTurnId)
      expect(res.workingTitle).toBe('Finished working')
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(200)
  })
})
