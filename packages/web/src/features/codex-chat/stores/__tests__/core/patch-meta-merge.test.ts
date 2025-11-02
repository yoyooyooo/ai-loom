import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../chat-turns'

describe('Store：endStep 对 meta.patch 定向深合并', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })
  afterEach(() => {
    chatTurnActions.reset()
  })

  it('begin: meta.patch(adds/dels) + end: meta.patch(success) → 保留 adds/dels 并合入 success', () => {
    // 开启一轮并添加一个 patch 步骤（模拟 patch.begin）
    chatTurnActions.markTurnStarted({})
    const callId = 'patch-1'
    chatTurnActions.addStep('patch', callId, 'patch a.txt', {
      status: 'streaming',
      meta: { patch: { adds: 2, dels: 1, firstPath: 'a.txt' } }
    })

    // 结束步骤（模拟 patch.end）：仅传入 success 字段
    chatTurnActions.endStep(callId, { status: 'completed', meta: { patch: { success: true } } })

    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    const t = slice.turns[slice.turns.length - 1]
    const step = t.steps[t.steps.length - 1] as any
    expect(step.kind).toBe('patch')
    expect(step.status).toBe('completed')
    expect(step.meta.patch.adds).toBe(2)
    expect(step.meta.patch.dels).toBe(1)
    expect(step.meta.patch.success).toBe(true)
  })
})
