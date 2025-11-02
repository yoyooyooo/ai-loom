import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { subscribeChatEvents } from '@/features/codex-chat/services/ws'
import {
  chatTurnActions,
  useChatTurnStore,
  chatTurnSelectors
} from '@/features/codex-chat/stores/chat-turns'

vi.mock('@/lib/ws/singleton')
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mock helper only exists in tests
import { __emit, __resetWsMock } from '@/lib/ws/singleton'

describe('exec.begin search 去重（含 $(...) 子命令场景）', () => {
  let stop: (() => void) | undefined

  beforeEach(() => {
    chatTurnActions.reset()
    __resetWsMock()
  })

  afterEach(() => {
    if (stop) stop()
    stop = undefined
    chatTurnActions.reset()
    __resetWsMock()
  })

  it('rg -n "..|.." $(fd …) -S 仅生成一条 search 步骤', () => {
    stop = subscribeChatEvents()
    chatTurnActions.setConversationId('conv-s')
    const cmd =
      'rg -n "struct NewConversationParams|enum ClientNotification" $(fd -a codex_app_server_protocol | head -n 1) -S'
    __emit('chat.tool.exec.begin', {
      conversationId: 'conv-s',
      callId: 'c1',
      cwd: '/repo',
      command: ['bash', '-lc', cmd]
    })
    const slice = chatTurnSelectors.currentSlice(useChatTurnStore.getState())
    expect(slice.turns.length).toBe(1)
    const steps = slice.turns[0]?.steps || []
    const searches = steps.filter((s: any) => s.kind === 'search')
    expect(searches.length).toBe(1)
    // 不应将 $(fd ...) 作为目标展示
    const meta = searches[0]?.meta || {}
    expect(String(meta.target || '')).not.toContain('$(')
  })
})
