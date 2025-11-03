import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock, __getFilters } from '@/lib/ws/singleton'

describe('WS 多会话快速切换串扰防护（按会话过滤 + 守卫）', () => {
  const RUNTIME_METHODS = [
    'chat.info.runtime.generating',
    'session.runtime',
    'chat.turn.started',
    'chat.turn.complete',
    'chat.message.delta',
    'chat.message.completed',
    'chat.message.failed',
    'chat.message.aborted'
  ]
  let stop: (() => void) | undefined
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })
  afterEach(() => {
    if (stop) stop()
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('多会话并行：迟到帧写入各自分片，当前视图不被串扰', async () => {
    stop = subscribeChatEvents()

    // 仅保留 runtime 专用订阅
    expect(__getFilters()).toEqual([
      {
        topic: 'chat',
        filter: { methods: RUNTIME_METHODS }
      }
    ])

    chatTurnActions.setConversationId('A')

    // A 与 B 同时来帧，应只接受 A
    __emit('chat.message.delta', { conversationId: 'B', delta: 'b1' })
    __emit('chat.message.delta', { conversationId: 'A', delta: 'a1' })
    __emit('chat.message.completed', { conversationId: 'A', text: 'A-OK' })
    __emit('chat.turn.complete', { conversationId: 'A' })

    let st = useChatTurnStore.getState()
    const sliceA = chatTurnSelectors.sliceById('A')(st)
    const sliceB = chatTurnSelectors.sliceById('B')(st)
    expect(sliceA.turns.length).toBeGreaterThan(0)
    const lastA = sliceA.turns[sliceA.turns.length - 1]
    expect(lastA.assistant.text).toBe('A-OK')
    // B 仍在 streaming（仅 delta）
    expect(sliceB.turns.length).toBe(1)
    expect(sliceB.turns[0]?.assistant.text).toContain('b1')

    // 立即切换到 B
    chatTurnActions.setConversationId('B')

    const turnsABeforeLate = chatTurnSelectors.sliceById('A')(useChatTurnStore.getState()).turns
      .length
    // A 的迟到帧（完成后才到的 delta）
    __emit('chat.message.delta', { conversationId: 'A', delta: 'A-late' })
    // B 的新帧
    __emit('chat.message.delta', { conversationId: 'B', delta: 'b2' })
    __emit('chat.message.completed', { conversationId: 'B', text: 'B-OK' })
    __emit('chat.turn.complete', { conversationId: 'B' })

    st = useChatTurnStore.getState()
    const sliceAAfter = chatTurnSelectors.sliceById('A')(st)
    const sliceBAfter = chatTurnSelectors.sliceById('B')(st)
    expect(sliceBAfter.turns.at(-1)?.assistant.text).toBe('B-OK')
    // A 的迟到帧不会污染当前视图，原 turn 保持稳定
    expect(sliceAAfter.turns.length).toBe(turnsABeforeLate)
    expect(sliceAAfter.turns.at(-1)?.assistant.text).toBe('A-OK')
    // 依旧只保留 runtime 专用订阅
    expect(__getFilters()).toEqual([
      {
        topic: 'chat',
        filter: { methods: RUNTIME_METHODS }
      }
    ])
  })
})
