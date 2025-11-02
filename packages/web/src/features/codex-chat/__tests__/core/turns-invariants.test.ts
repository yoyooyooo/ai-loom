import { describe, it, beforeEach, afterEach, expect } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

describe('Turns 不变量（Store 层面）', () => {
  beforeEach(() => chatTurnActions.reset())
  afterEach(() => chatTurnActions.reset())

  it('完成一轮后：无 streaming 步骤、activeTurnId 清空、generating=false、toolIndex 清空', () => {
    chatTurnActions.setConversationId('conv-i')
    chatTurnActions.markTurnStarted({})
    const callId = chatTurnActions.addStep('exec', 'c1', 'bash -lc echo ok', {
      status: 'streaming'
    })
    chatTurnActions.endStep('c1', { status: 'completed', meta: { exitCode: 0 } })
    chatTurnActions.completeAssistant('done')
    chatTurnActions.completeTurn()

    const st = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(st)
    expect(slice.activeTurnId).toBeUndefined()
    expect(slice.generating).toBe(false)
    const t = slice.turns.at(-1)!
    expect(t.status).toBe('completed')
    expect(Array.isArray(t.steps)).toBe(true)
    expect(t.steps.every((s: any) => s.status !== 'streaming')).toBe(true)
    // toolIndex 清空（不包含本轮 c1）
    expect(slice.toolIndex['c1']).toBeUndefined()
    // 步骤聚合存在
    expect(t.steps.some((s: any) => s.kind === 'exec')).toBe(true)
  })

  it('failed/aborted 收尾：turn 状态与 assistant 文本符合期望', () => {
    // failed
    chatTurnActions.markTurnStarted({})
    chatTurnActions.failAssistant('err')
    chatTurnActions.completeTurn()
    // aborted（新一轮）
    chatTurnActions.markTurnStarted({})
    chatTurnActions.abortAssistant()
    chatTurnActions.completeTurn()

    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(2)
    const f = slice.turns[0]
    const a = slice.turns[1]
    expect(f.status).toBe('failed')
    expect(a.status).toBe('aborted')
    expect(f.assistant?.text || '').toContain('err')
    expect(typeof a.assistant?.text).toBe('string')
  })
})
