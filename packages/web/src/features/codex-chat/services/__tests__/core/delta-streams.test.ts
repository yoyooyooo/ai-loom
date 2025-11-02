import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { ensureDeltaPipelines } from '@/features/codex-chat/services/delta-streams'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

vi.mock('@/lib/ws/singleton')

describe('delta-streams 隐式开启（Rx 批处理场景）', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })
  afterEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('agent_message_delta 首次抵达时自动 beginTurn 并追加 delta', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx')
    __emit('chat.message.delta', { conversationId: 'conv-rx', delta: 'Hello' })
    await waitFor(
      () => expect(chatTurnSelectors.currentTurns(useChatTurnStore.getState()).length).toBe(1),
      {
        timeout: 800
      }
    )
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    const t = slice.turns[0]
    expect(slice.activeTurnId).toBe(t.id)
    expect(t.assistant.text).toContain('Hello')
  })

  it('agent_reasoning_delta 首次抵达时自动 beginTurn 并追加 reasoning', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx2')
    __emit('chat.reasoning.delta', { conversationId: 'conv-rx2', delta: 'Thinking' })
    await waitFor(
      () => expect(chatTurnSelectors.currentTurns(useChatTurnStore.getState()).length).toBe(1),
      {
        timeout: 800
      }
    )
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    const t = slice.turns[0]
    expect(slice.activeTurnId).toBe(t.id)
    expect(t.reasoning?.content || '').toContain('Thinking')
  })

  it('exec.output 被微批合并并追加到步骤', async () => {
    ensureDeltaPipelines()
    chatTurnActions.setConversationId('conv-rx3')
    // 先创建一个 exec 步骤，模拟 begin 事件已到达
    chatTurnActions.markTurnStarted({})
    const callId = 'c-1'
    chatTurnActions.addStep('exec', callId, 'echo test', {
      meta: { callId },
      status: 'streaming' as any
    })
    // 高频输出（将被微批合并）
    __emit('chat.tool.exec.output', { conversationId: 'conv-rx3', callId, text: 'A' })
    __emit('chat.tool.exec.output', { conversationId: 'conv-rx3', callId, text: 'B' })
    __emit('chat.tool.exec.output', { conversationId: 'conv-rx3', callId, text: 'C' })
    await waitFor(
      () => {
        const st = useChatTurnStore.getState()
        const slice = chatTurnSelectors.currentSlice(st)
        const t = slice.turns[0]
        const step = t.steps.find((s) => s.kind === 'exec') as any
        expect(step).toBeTruthy()
        expect(step?.body || '').toContain('ABC')
      },
      { timeout: 800 }
    )
  })

  it('迟到的 chat.message.delta（eventId <= completed）会被丢弃而不会新开 turn', async () => {
    ensureDeltaPipelines()
    const cid = 'conv-rx4'
    chatTurnActions.setConversationId(cid)

    __emit('chat.message.delta', { conversationId: cid, delta: 'Hello ', eventId: 101 })
    __emit('chat.message.delta', { conversationId: cid, delta: 'world', eventId: 102 })

    await waitFor(
      () => {
        const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
        expect(slice.turns.length).toBe(1)
        const turn = slice.turns[0]
        expect(turn.assistant.text).toBe('Hello world')
        expect(slice.activeTurnId).toBe(turn.id)
      },
      { timeout: 800 }
    )

    chatTurnActions.completeAssistant('Hello world', undefined, 105)
    chatTurnActions.completeTurn()

    await waitFor(
      () => {
        const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
        const turn = slice.turns[0]
        expect(slice.activeTurnId).toBeUndefined()
        expect(turn.status).toBe('completed')
        expect(((turn as any).meta?.extra)?.assistantCompletedEventId).toBe(105)
      },
      { timeout: 800 }
    )

    __emit('chat.message.delta', { conversationId: cid, delta: 'world', eventId: 104 })
    await new Promise((resolve) => setTimeout(resolve, 40))

    const sliceAfter = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(sliceAfter.turns.length).toBe(1)
    const finalTurn = sliceAfter.turns[0]
    expect(finalTurn.assistant.text).toBe('Hello world')
    expect(sliceAfter.activeTurnId).toBeUndefined()
  })

  it('完成后迟到的尾段（无 eventId）不会新开气泡（按文本尾部匹配丢弃）', async () => {
    ensureDeltaPipelines()
    const cid = 'conv-rx5'
    chatTurnActions.setConversationId(cid)

    // 正常生成过程
    __emit('chat.message.delta', { conversationId: cid, delta: '我先在仓库里快速搜搜 ' })
    __emit('chat.message.delta', { conversationId: cid, delta: 'RxJS 的使用点和常见操作符。' })

    await waitFor(
      () => {
        const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
        expect(slice.turns.length).toBe(1)
        const turn = slice.turns[0]
        expect(turn.assistant.text).toContain('RxJS')
      },
      { timeout: 800 }
    )

    // 标记完成（模拟 message.completed → turn.complete）
    chatTurnActions.completeAssistant('我先在仓库里快速搜搜 RxJS 的使用点和常见操作符。', undefined, 200)
    chatTurnActions.completeTurn()

    await waitFor(
      () => {
        const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
        const turn = slice.turns[0]
        expect(turn.status).toBe('completed')
      },
      { timeout: 800 }
    )

    // 迟到的“尾段”delta（无 eventId），等于已完成文本的结尾
    __emit('chat.message.delta', {
      conversationId: cid,
      delta: '的使用点和常见操作符。' // 尾部重复
    })
    await new Promise((r) => setTimeout(r, 40))

    // 不应新开一轮，不应改变助手文本
    const sliceAfter = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(sliceAfter.turns.length).toBe(1)
    const finalTurn = sliceAfter.turns[0]
    expect(finalTurn.status).toBe('completed')
    expect(finalTurn.assistant.text).toBe('我先在仓库里快速搜搜 RxJS 的使用点和常见操作符。')
    expect(sliceAfter.activeTurnId).toBeUndefined()
  })

  it('turn 完成后缓冲的 delta 会被丢弃，不会重新开启 turn', async () => {
    ensureDeltaPipelines()
    const cid = 'conv-rx6'
    chatTurnActions.setConversationId(cid)

    // 先流入一段 delta（可能被微批暂存）
    __emit('chat.message.delta', { conversationId: cid, delta: 'Hello', eventId: 301 })

    // turn 在 delta flush 之前就收束
    __emit('chat.message.completed', { conversationId: cid, text: 'Hello', eventId: 305 })
    chatTurnActions.completeAssistant('Hello', undefined, 305)
    chatTurnActions.completeTurn()

    await new Promise((resolve) => setTimeout(resolve, 40))

    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(1)
    const turn = slice.turns[0]
    expect(turn.status).toBe('completed')
    expect(turn.assistant.text).toBe('Hello')
    expect(slice.activeTurnId).toBeUndefined()
  })
})
