import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import { chatTurnActions, useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('WS：Compact 特例（不结束/不新起轮，仅插入 info 步骤）', () => {
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

  it('chat.message.completed=Compact task completed → 插入 info 步骤且不结束 turn', async () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-cm')

    __emit('chat.message.delta', { conversationId: 'conv-cm', delta: 'partial' })
    __emit('chat.message.completed', { conversationId: 'conv-cm', text: 'Compact task completed' })

    const st = useChatTurnStore.getState()
    expect(st.turns.length).toBe(1)
    const t = st.turns[0]
    expect(t.assistant.text).toContain('partial')
    // 未结束（仍 streaming），Working 存在
    const d = useChatTurnStore.getState().deriveWorkingState(t.id)
    expect(d.working).toBe(true)
    // 存在 Compact info 步骤
    const info = t.steps.find((s) => s.kind === 'info' && (s.meta?.compactDone === true))
    expect(info).toBeTruthy()
  })
})

