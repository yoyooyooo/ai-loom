import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

import basic from '@/features/codex-chat/__tests__/fixtures/resume-events-basic.json'
import compact from '@/features/codex-chat/__tests__/fixtures/resume-events-compact.json'
import execFx from '@/features/codex-chat/__tests__/fixtures/resume-events-exec.json'
import mcpFx from '@/features/codex-chat/__tests__/fixtures/resume-events-mcp.json'
import failedFx from '@/features/codex-chat/__tests__/fixtures/resume-events-failed.json'
import abortedFx from '@/features/codex-chat/__tests__/fixtures/resume-events-aborted.json'

describe('loadServerTurns → store turns', () => {
  beforeEach(() => {
    chatTurnActions.reset()
  })
  afterEach(() => {
    chatTurnActions.reset()
  })

  it('basic: builds a single completed turn with assistant text', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'hello', ts: '' },
        assistant: { text: 'Hello' },
        steps: []
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns).toHaveLength(1)
    const t = slice.turns[0]
    expect(t.status).toBe('completed')
    expect((t.assistant?.text || '').trim()).toBe('Hello')
    expect(t.steps.length).toBe(0)
  })

  it('compact: attaches info step to previous turn and does not create a new turn', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'a' },
        steps: [
          {
            id: 'i1',
            kind: 'info',
            title: '[Compact] 任务完成',
            status: 'completed',
            ts: '',
            meta: { compactDone: true }
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns).toHaveLength(1)
    const t = slice.turns[0]
    expect(t.status).toBe('completed')
    const info = t.steps.find((s) => s.kind === 'info' && s.meta?.compactDone)
    expect(info).toBeTruthy()
    expect(info?.title).toBe('[Compact] 任务完成')
  })

  it('exec tool: aggregates begin/output/end as a single step and keeps metadata', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'a' },
        steps: [
          {
            id: 'e1',
            kind: 'exec',
            title: 'bash -lc echo ok',
            status: 'completed',
            ts: '',
            meta: { command: ['bash', '-lc', 'echo ok'], cwd: '/tmp' },
            body: 'ok'
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const step = t.steps.find((s) => s.kind === 'exec')
    expect(step).toBeTruthy()
    expect(step?.status).toBe('completed')
    expect(Array.isArray(step?.meta?.command)).toBe(true)
    expect(step?.meta?.cwd).toBe('/tmp')
  })

  it('mcp tool: server/tool/args/result', () => {
    const turns = [
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'a' },
        steps: [
          {
            id: 'm1',
            kind: 'mcp',
            title: 'sv:tl',
            status: 'completed',
            ts: '',
            meta: { server: 'sv', tool: 'tl', args: { x: 1 }, result: { ok: true } }
          }
        ]
      }
    ]
    chatTurnActions.loadServerTurns(turns as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const step = t.steps.find((s) => s.kind === 'mcp')
    expect(step).toBeTruthy()
    expect(step?.status).toBe('completed')
    expect(step?.meta?.server).toBe('sv')
    expect(step?.meta?.tool).toBe('tl')
    expect(step?.meta?.result).toBeDefined()
  })

  it('failed: marks turn as failed', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        status: 'failed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'error' },
        steps: []
      }
    ] as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    expect(t.status).toBe('failed')
  })

  it('aborted: marks turn as aborted', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        status: 'aborted',
        user: { text: 'u', ts: '' },
        assistant: { text: '' },
        steps: []
      }
    ] as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    expect(t.status).toBe('aborted')
  })

  it('exec step with rg command becomes search step with output preserved', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'a' },
        steps: [
          {
            id: 's1',
            kind: 'exec',
            title: 'bash -lc rg "todo" packages',
            status: 'completed',
            ts: '',
            meta: {
              command: ['bash', '-lc', 'rg "todo" packages'],
              cwd: '/repo',
              callId: 'call-search',
              exitCode: 0
            },
            body: 'packages/web/src/app.ts:1:todo\n'
          }
        ]
      }
    ] as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const search = t.steps.find((s) => s.kind === 'search')
    expect(search).toBeTruthy()
    expect(search?.meta?.query).toBe('todo')
    expect(search?.meta?.target).toBe('/repo/packages')
    expect(search?.meta?.exitCode).toBe(0)
    expect(search?.body).toBe('packages/web/src/app.ts:1:todo\n')
    expect(t.steps.some((s) => s.kind === 'exec')).toBe(false)
  })

  it('exec step with cat command becomes read step', () => {
    chatTurnActions.loadServerTurns([
      {
        id: 't1',
        seq: 1,
        status: 'completed',
        user: { text: 'u', ts: '' },
        assistant: { text: 'a' },
        steps: [
          {
            id: 's2',
            kind: 'exec',
            title: 'bash -lc cat README.md',
            status: 'completed',
            ts: '',
            meta: {
              command: ['bash', '-lc', 'cat README.md'],
              cwd: '/repo',
              callId: 'call-read'
            },
            body: 'Hello world\n'
          }
        ]
      }
    ] as any)
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const read = t.steps.find((s) => s.kind === 'read')
    expect(read).toBeTruthy()
    expect(read?.meta?.file).toBe('/repo/README.md')
    expect(read?.body).toBe('Hello world\n')
  })
})
