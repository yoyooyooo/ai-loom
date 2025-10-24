import { describe, it, beforeEach, expect } from 'vitest'
import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'
import execFixture from './fixtures/resume-events-exec.json'

describe('resume pipeline to turns (events-only)', () => {

  beforeEach(() => {
    chatTurnActions.reset()
  })

  it('hydrates events into turn steps', () => {
    chatTurnActions.loadSnapshot([], (execFixture as any).events)

    const state = useChatTurnStore.getState()
    expect(state.turns.length).toBeGreaterThan(0)
    const withSteps = state.turns.find((turn) => turn.steps.length > 0)
    expect(withSteps).toBeTruthy()
    const execStep = withSteps?.steps.find((step) => step.kind === 'exec')
    expect(execStep).toBeTruthy()
    expect(execStep?.status).toBe('completed')
    expect(execStep?.body && execStep.body.length).toBeGreaterThan(0)

    // 其他步骤（patch/mcp/info）按实际会话可能不存在，这里不强制要求
  })

  it('is idempotent when loadSnapshot called twice', () => {
    const events = (execFixture as any).events
    chatTurnActions.loadSnapshot([], events)
    const once = useChatTurnStore.getState().turns.map((turn) => turn.steps.length)

    chatTurnActions.loadSnapshot([], events)
    const twice = useChatTurnStore.getState().turns.map((turn) => turn.steps.length)

    expect(twice).toEqual(once)
  })
})
