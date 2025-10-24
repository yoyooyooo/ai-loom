import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chatTurnActions, useChatTurnStore } from './chat-turns'

import basic from '../__tests__/fixtures/resume-events-basic.json'
import compact from '../__tests__/fixtures/resume-events-compact.json'
import execFx from '../__tests__/fixtures/resume-events-exec.json'
import mcpFx from '../__tests__/fixtures/resume-events-mcp.json'
import failedFx from '../__tests__/fixtures/resume-events-failed.json'
import abortedFx from '../__tests__/fixtures/resume-events-aborted.json'

describe('loadSnapshot(events-only) → applyEventsToTurns', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })
  afterEach(() => {
    chatTurnActions.reset()
  })

  it('basic: builds a single completed turn with assistant text', () => {
    chatTurnActions.loadSnapshot([], (basic as any).events)
    const state = useChatTurnStore.getState()
    expect(state.turns).toHaveLength(1)
    const t = state.turns[0]
    expect(t.status).toBe('completed')
    expect((t.assistant?.text || '').trim()).toBe('Hello')
    expect(t.steps.length).toBe(0)
  })

  it('compact: attaches info step to previous turn and does not create a new turn', () => {
    chatTurnActions.loadSnapshot([], (compact as any).events)
    const state = useChatTurnStore.getState()
    expect(state.turns).toHaveLength(1)
    const t = state.turns[0]
    expect(t.status).toBe('completed')
    const info = t.steps.find((s) => s.kind === 'info' && s.meta?.compactDone)
    expect(info).toBeTruthy()
    expect(info?.title).toBe('[Compact] 任务完成')
  })

  it('exec tool: aggregates begin/output/end as a single step and keeps metadata', () => {
    chatTurnActions.loadSnapshot([], (execFx as any).events)
    const t = useChatTurnStore.getState().turns[0]
    const step = t.steps.find((s) => s.kind === 'exec')
    expect(step).toBeTruthy()
    expect(step?.status).toBe('completed')
    expect(Array.isArray(step?.meta?.command)).toBe(true)
    expect(step?.meta?.cwd).toBe('/tmp')
  })

  it('mcp tool: begin/end with server/tool/arguments/result', () => {
    chatTurnActions.loadSnapshot([], (mcpFx as any).events)
    const t = useChatTurnStore.getState().turns[0]
    const step = t.steps.find((s) => s.kind === 'mcp')
    expect(step).toBeTruthy()
    expect(step?.status).toBe('completed')
    expect(step?.meta?.server).toBe('sv')
    expect(step?.meta?.tool).toBe('tl')
    expect(step?.meta?.result).toBeDefined()
  })

  it('failed: marks turn as failed', () => {
    chatTurnActions.loadSnapshot([], (failedFx as any).events)
    const t = useChatTurnStore.getState().turns[0]
    expect(t.status).toBe('failed')
  })

  it('aborted: marks turn as aborted', () => {
    chatTurnActions.loadSnapshot([], (abortedFx as any).events)
    const t = useChatTurnStore.getState().turns[0]
    expect(t.status).toBe('aborted')
  })
})
