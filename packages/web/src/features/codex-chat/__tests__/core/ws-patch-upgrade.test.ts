import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chatTurnActions, chatTurnSelectors, useChatTurnStore } from '../../stores/chat-turns'
import { createProcessChatEvent } from '../../services/processors'

describe('WS：patch.begin 与 exec 重叠时升级步骤展示', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    chatTurnActions.setConversationId('conv-patch-upgrade')
  })

  afterEach(() => {
    chatTurnActions.reset()
  })

  it('patch.begin 复用同一 callId 时，应将已有 exec 步骤转换为 patch 卡片', () => {
    const processor = createProcessChatEvent({
      useRxDelta: false,
      aggregateTools: true,
      keepToolStream: false,
      patchMaxFiles: 8,
      patchMaxChars: 2000
    })

    processor('chat.tool.exec.begin', {
      conversationId: 'conv-patch-upgrade',
      callId: 'call-1',
      command: ['bash', '-lc', 'echo noop']
    })

    let slice = chatTurnSelectors.sliceById('conv-patch-upgrade')(useChatTurnStore.getState())
    let turn = slice.turns.at(-1)!
    expect(turn.steps).toHaveLength(1)
    expect(turn.steps[0].kind).toBe('exec')

    processor('chat.tool.patch.begin', {
      conversationId: 'conv-patch-upgrade',
      callId: 'call-1',
      files: 1,
      firstPath: '/tmp/demo/a.txt',
      adds: 3,
      dels: 1,
      autoApproved: true,
      changes: {
        '/tmp/demo/a.txt': {
          update: {
            unified_diff: '--- a\n+++ b\n+demo'
          }
        }
      }
    })

    slice = chatTurnSelectors.sliceById('conv-patch-upgrade')(useChatTurnStore.getState())
    turn = slice.turns.at(-1)!
    expect(turn.steps).toHaveLength(1)
    const step = turn.steps[0] as any
    expect(step.kind).toBe('patch')
    expect(step.title).toContain('patch a.txt')
    expect(step.meta?.patch?.adds).toBe(3)
    expect(step.body).toContain('+++ b')
    expect(step.status).toBe('streaming')
  })
})
