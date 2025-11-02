import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { chatApi } from '@/features/codex-chat/services/api'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock, __setOnline } from '@/lib/ws/singleton'

describe('WS 断线重连 + resume（按会话过滤 + 回放增量 → Store）', () => {
  let stop: (() => void) | undefined
  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
    vi.spyOn(chatApi, 'getConfig').mockResolvedValue({
      models: [],
      defaults: { model: 'm', approvalPolicy: 'on-request', sandboxMode: 'workspace-write' }
    } as any)
  })
  afterEach(() => {
    if (stop) stop()
    chatTurnActions.reset()
    __resetWsMock()
    vi.restoreAllMocks()
  })

  it('down→up：仅回放当前会话的增量（忽略其它会话）', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-r')

    // 断线
    __setOnline(false)

    // 重连：模拟 resume 回放的增量（手动 __emit 即可代表 resume 回放）
    __setOnline(true)
    __emit('chat.message.delta', { conversationId: 'other', delta: 'skip' })
    __emit('chat.message.delta', { conversationId: 'conv-r', delta: 'hello' })
    __emit('chat.message.completed', { conversationId: 'conv-r', text: 'OK' })
    __emit('chat.turn.complete', { conversationId: 'conv-r' })

    const st = useChatTurnStore.getState()
    const slice = chatTurnSelectors.sliceById('conv-r')(st)
    expect(slice.turns.length).toBeGreaterThan(0)
    const last = slice.turns[slice.turns.length - 1]
    expect(last.assistant.text).toBe('OK')
    // 并行模型：其它会话写入独立分片，当前视图不受影响
    const otherSlice = chatTurnSelectors.sliceById('other')(st)
    expect(otherSlice.turns.length).toBe(1)
    expect(otherSlice.turns[0]?.assistant.text).toBe('skip')
  })
})
