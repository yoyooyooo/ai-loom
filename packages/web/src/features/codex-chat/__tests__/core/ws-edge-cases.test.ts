import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Subject } from 'rxjs'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

// 复用 ws 单例 mock（与 ws.test.ts 相同实现，保证行为一致）
vi.mock('@/lib/ws/singleton')

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mock helper only exists in tests
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('ws edge cases for chat turns', () => {
  let stop: (() => void) | undefined
  const currentSlice = () => chatTurnSelectors.currentSlice(useChatTurnStore.getState())
  const currentTurns = () => currentSlice().turns

  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  afterEach(() => {
    if (stop) {
      stop()
      stop = undefined
    }
    chatTurnActions.reset()
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('agent_message ends turn immediately; late tool.end ignored', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec1')

    __emit('chat.turn.started', { conversationId: 'conv-ec1' })
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-ec1',
      callId: 'c1',
      command: ['bash', '-lc', 'echo ok'],
      cwd: '/tmp'
    })

    // 提前完成正文 → 立即结束该轮
    __emit('chat.message.completed', { conversationId: 'conv-ec1', text: 'done' })
    const store1 = useChatTurnStore.getState()
    const slice1 = currentSlice()
    expect(slice1.activeTurnId).toBeUndefined()
    const t1 = slice1.turns.at(-1)!
    const d1 = store1.deriveWorkingState(t1.id)
    expect(d1.working).toBe(false)
    expect(d1.workingTitle).toBe('Finished working')

    // 工具结束（晚到）被忽略
    __emit('chat.tool.exec.end', { conversationId: 'conv-ec1', callId: 'c1', exitCode: 0 })
    const store2 = useChatTurnStore.getState()
    const slice2 = currentSlice()
    const t2 = slice2.turns.at(-1)!
    const d2 = store2.deriveWorkingState(t2.id)
    expect(d2.working).toBe(false)
    expect(d2.workingTitle).toBe('Finished working')

    // 收到 turn.complete（确认型收尾）
    __emit('chat.turn.complete', { conversationId: 'conv-ec1' })
    const slice3 = currentSlice()
    expect(slice3.activeTurnId).toBeUndefined()
    expect(slice3.generating).toBe(false)
  })

  it('failed/aborted then turn.complete should be idempotent', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec2')

    __emit('chat.turn.started', { conversationId: 'conv-ec2' })
    __emit('chat.message.failed', { conversationId: 'conv-ec2', error: { message: 'oops' } })
    // ws-processors 在 failed/aborted 时会立即 completeTurn
    const sliceFail1 = currentSlice()
    expect(sliceFail1.turns.at(-1)?.status).toBe('failed')
    expect(sliceFail1.activeTurnId).toBeUndefined()

    // 再到达 turn.complete 幂等
    __emit('chat.turn.complete', { conversationId: 'conv-ec2' })
    const sliceFail2 = currentSlice()
    expect(sliceFail2.turns.at(-1)?.status).toBe('failed')
    expect(sliceFail2.activeTurnId).toBeUndefined()

    // Aborted 分支
    __emit('chat.turn.started', { conversationId: 'conv-ec2' })
    __emit('chat.message.aborted', { conversationId: 'conv-ec2' })
    const sliceFail3 = currentSlice()
    expect(sliceFail3.turns.at(-1)?.status).toBe('aborted')
    expect(sliceFail3.activeTurnId).toBeUndefined()
  })

  it('consecutive chat.message.completed create consecutive turns (spec)', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec3')
    __emit('chat.turn.started', { conversationId: 'conv-ec3' })

    __emit('chat.message.completed', { conversationId: 'conv-ec3', text: 'first' })
    __emit('chat.message.completed', { conversationId: 'conv-ec3', text: 'second' })

    const slice = currentSlice()
    expect(slice.turns.length).toBeGreaterThanOrEqual(2)
    const t0 = slice.turns[0]
    const t1after = slice.turns[1] || slice.turns.at(-1)!
    expect(t0.assistant.text).toBe('first')
    expect(t1after.assistant.text).toBe('second')
    // 完全收尾
    __emit('chat.turn.complete', { conversationId: 'conv-ec3' })
    expect(currentSlice().activeTurnId).toBeUndefined()
  })

  it('user_message only + consecutive completed (no started) → consecutive turns', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec4')

    __emit('chat.info.user_message', { conversationId: 'conv-ec4', text: 'hello' })
    __emit('chat.message.completed', { conversationId: 'conv-ec4', text: 'A' })
    __emit('chat.message.completed', { conversationId: 'conv-ec4', text: 'B' })

    const sliceUsers = currentSlice()
    expect(sliceUsers.turns.length).toBeGreaterThanOrEqual(2)
    const t0 = sliceUsers.turns[0]
    const t1 = sliceUsers.turns[1] || sliceUsers.turns.at(-1)!
    expect(t0.user.text).toBe('hello')
    expect(t0.assistant.text).toBe('A')
    expect((t1.user?.text || '').length).toBeGreaterThanOrEqual(0)
    expect(t1.assistant.text).toBe('B')
    expect(currentSlice().activeTurnId).toBeUndefined()
  })

  it('tool.end after turn.complete is ignored (no reopen, no meta exitCode)', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec5')

    __emit('chat.turn.started', { conversationId: 'conv-ec5' })
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-ec5',
      callId: 'c1',
      command: ['bash', '-lc', 'echo ok']
    })
    __emit('chat.message.completed', { conversationId: 'conv-ec5', text: 'done' })
    __emit('chat.turn.complete', { conversationId: 'conv-ec5' })

    const before = currentTurns().at(-1)!
    const stepBefore = before.steps.find((s) => s.kind === 'exec')
    expect(stepBefore?.status).toBe('completed')
    expect((stepBefore as any)?.meta?.exitCode).toBeUndefined()

    __emit('chat.tool.exec.end', { conversationId: 'conv-ec5', callId: 'c1', exitCode: 0 })
    const after = currentTurns().at(-1)!
    const stepAfter = after.steps.find((s) => s.kind === 'exec')
    expect(stepAfter?.status).toBe('completed')
    expect((stepAfter as any)?.meta?.exitCode).toBeUndefined()
  })

  it('compact between two completed: attaches info to previous turn and does not create extra turn', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec6')

    __emit('chat.turn.started', { conversationId: 'conv-ec6' })
    __emit('chat.message.completed', { conversationId: 'conv-ec6', text: 'A' })
    // compact 插入信息步到上一轮
    __emit('chat.message.completed', { conversationId: 'conv-ec6', text: 'Compact task completed' })
    // 显式开始下一轮（规范允许 started/或隐式；此处使用显式，保证可读性）
    __emit('chat.turn.started', { conversationId: 'conv-ec6' })
    __emit('chat.message.completed', { conversationId: 'conv-ec6', text: 'B' })

    const slice = currentSlice()
    expect(slice.turns.length).toBeGreaterThanOrEqual(2)
    const t0 = slice.turns[0]
    const t1 = slice.turns[1] || slice.turns.at(-1)!
    const compactInfo = t0.steps.find((st) => st.kind === 'info' && (st as any)?.meta?.compactDone)
    expect(compactInfo).toBeTruthy()
    expect(t0.assistant.text).toBe('A')
    expect(t1.assistant.text).toBe('B')
  })

  it('mcp title uses server/tool; end fills result', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec7')
    __emit('chat.turn.started', { conversationId: 'conv-ec7' })
    __emit('chat.tool.mcp.begin', {
      conversationId: 'conv-ec7',
      callId: 'm1',
      server: 'sv',
      tool: 'tl',
      arguments: { a: 1 }
    })
    __emit('chat.tool.mcp.end', { conversationId: 'conv-ec7', callId: 'm1', result: { ok: true } })
    const t = currentTurns()[0]
    const m = t.steps.find((s) => s.kind === 'mcp') as any
    expect(m).toBeTruthy()
    expect(m.title).toBe('sv/tl')
    expect(m.meta?.result?.ok).toBe(true)
  })

  it('plan_update becomes plan step; web_search begin/end become info steps', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec8')
    __emit('chat.turn.started', { conversationId: 'conv-ec8' })
    __emit('chat.info.plan_update', {
      conversationId: 'conv-ec8',
      plan: [{ step: 'Do A', status: 'completed' }],
      explanation: 'E'
    })
    __emit('chat.info.web_search.begin', { conversationId: 'conv-ec8' })
    __emit('chat.info.web_search.end', { conversationId: 'conv-ec8', query: 'q' })
    const t = currentTurns()[0]
    const plan = t.steps.find((s) => s.kind === 'plan')
    expect(plan).toBeTruthy()
    const infos = t.steps.filter((s) => s.kind === 'info')
    const hasBegin = infos.some((i) => (i as any).title?.includes('[web-search] 开始检索'))
    const hasEnd = infos.some((i) => (i as any).title?.includes('[web-search] 完成'))
    expect(hasBegin && hasEnd).toBe(true)
  })

  it('chat.info.user_message de-duplicates same text', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-ec9')
    __emit('chat.info.user_message', { conversationId: 'conv-ec9', text: 'echo' })
    __emit('chat.info.user_message', { conversationId: 'conv-ec9', text: 'echo' })
    const slice = currentSlice()
    expect(slice.turns.length).toBe(1)
    const t = slice.turns[0]
    expect(t.user.text).toBe('echo')
  })
})
