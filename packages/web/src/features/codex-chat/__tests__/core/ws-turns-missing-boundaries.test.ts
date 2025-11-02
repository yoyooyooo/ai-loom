import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { vi } from 'vitest'
vi.mock('@/lib/ws/singleton')
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('WS → turns 行为覆盖（缺失边界与异常兜底）', () => {
  let stop: (() => void) | undefined
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
  })

  it('缺失 chat.turn.started：message.delta 隐式开启；completed 立即结束该轮（Working=Finished）', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-x')
    __emit('chat.message.delta', { conversationId: 'conv-x', delta: 'hi ' })
    __emit('chat.message.completed', { conversationId: 'conv-x', text: 'done' })
    const store = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(store)
    expect(slice.turns).toHaveLength(1)
    const t = slice.turns[0]
    expect(t.assistant.text).toContain('done')
    const d = store.deriveWorkingState(t.id)
    expect(d.working).toBe(false)
    expect(d.workingTitle).toBe('Finished working')
    // 立即结束：activeTurnId 为空（turn.complete 为确认型收尾）
    expect(slice.activeTurnId).toBeUndefined()
  })

  it('Compact 特例（WS）：插入 info 步骤且不新建 turn', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-c')
    __emit('chat.turn.started', { conversationId: 'conv-c' })
    __emit('chat.message.completed', { conversationId: 'conv-c', text: 'Compact task completed' })
    const store = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(store)
    expect(slice.turns).toHaveLength(1)
    const t = slice.turns[0]
    const info = t.steps.find((s) => s.kind === 'info' && (s as any)?.meta?.compactDone)
    expect(info).toBeTruthy()
    __emit('chat.turn.complete', { conversationId: 'conv-c' })
    expect(chatTurnSelectors.currentSlice(useChatTurnStore.getState()).activeTurnId).toBeUndefined()
  })

  it('工具并发：exec + mcp 各自聚合并完成', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-t')
    __emit('chat.turn.started', { conversationId: 'conv-t' })
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-t',
      callId: 'c1',
      command: ['bash', '-lc', 'echo 1']
    })
    __emit('chat.tool.mcp.begin', {
      conversationId: 'conv-t',
      callId: 'm1',
      server: 'sv',
      tool: 'tl',
      arguments: { x: 1 }
    })
    __emit('chat.tool.exec.output', { conversationId: 'conv-t', callId: 'c1', text: '1' })
    __emit('chat.tool.exec.end', {
      conversationId: 'conv-t',
      callId: 'c1',
      exitCode: 0,
      stdout: '1'
    })
    __emit('chat.tool.mcp.end', { conversationId: 'conv-t', callId: 'm1', result: { ok: true } })
    __emit('chat.message.completed', { conversationId: 'conv-t', text: 'done' })
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    const ex = t.steps.find((s) => s.kind === 'exec')
    const mc = t.steps.find((s) => s.kind === 'mcp')
    expect(ex?.status).toBe('completed')
    expect(mc?.status).toBe('completed')
  })

  it('异常：exec.output/end 无 begin 被忽略（不产生步骤）', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-e')
    __emit('chat.turn.started', { conversationId: 'conv-e' })
    __emit('chat.tool.exec.output', { conversationId: 'conv-e', callId: 'missing', text: 'oops' })
    __emit('chat.tool.exec.end', { conversationId: 'conv-e', callId: 'missing', exitCode: 0 })
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    expect(Array.isArray(t.steps) && t.steps.length === 0).toBe(true)
  })

  it('异常：patch 无 callId begin + 无 callId end → 结束不了（保持 Working）', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-p')
    __emit('chat.turn.started', { conversationId: 'conv-p' })
    __emit('chat.tool.patch.begin', {
      conversationId: 'conv-p',
      files: 2,
      firstPath: 'a.txt',
      autoApproved: true
    })
    __emit('chat.tool.patch.end', { conversationId: 'conv-p', success: true })
    const store = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(store)
    const t = slice.turns[0]
    const d = store.deriveWorkingState(t.id)
    expect(d.working).toBe(true)
  })

  it('reasoning.section_break 在无正文时不追加分隔符', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-r')
    __emit('chat.turn.started', { conversationId: 'conv-r' })
    __emit('chat.reasoning.section_break', { conversationId: 'conv-r' })
    const t = chatTurnSelectors.currentTurns(useChatTurnStore.getState())[0]
    expect(t.reasoning?.content || '').not.toContain('---')
  })
})
