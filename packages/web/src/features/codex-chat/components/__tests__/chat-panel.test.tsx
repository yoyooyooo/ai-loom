import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CodexChatPanel } from '@/features/codex-chat/components/chat-panel'
import {
  chatTurnActions,
  chatTurnSelectors,
  useChatTurnStore
} from '@/features/codex-chat/stores/chat-turns'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'

const { toastMock } = vi.hoisted(() => {
  const toastFn: any = vi.fn()
  toastFn.error = vi.fn()
  toastFn.success = vi.fn()
  return { toastMock: toastFn }
})

vi.mock('sonner', () => ({ toast: toastMock }))

vi.mock('@/features/codex-chat/services/ws', () => ({
  subscribeChatEvents: vi.fn(() => () => {})
}))

const sendMessageMock = vi.fn()
const sendUserTurnMock = vi.fn()
const getConfigMock = vi.fn()

vi.mock('@/features/codex-chat/services/api', () => ({
  chatApi: {
    newConversation: vi.fn(),
    getConfig: (...args: any[]) => getConfigMock(...args),
    sendMessage: (...args: any[]) => sendMessageMock(...args),
    sendUserTurn: (...args: any[]) => sendUserTurnMock(...args),
    interrupt: vi.fn()
  }
}))

vi.mock('@/components/ui/message-input', () => ({
  MessageInput: (props: any) => (
    <div>
      <textarea data-testid="chat-input" value={props.value} onChange={props.onChange} />
      <button type="submit" disabled={props.isGenerating || props.value === ''}>
        发送
      </button>
      {props.leftExtras}
    </div>
  )
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useParams: () => ({})
  }
})

describe('CodexChatPanel onSend', () => {
  beforeEach(() => {
    chatTurnActions.reset()
    codexChatProviderActions.resetAll()
    chatTurnActions.setConversationId('conv-err')
    getConfigMock.mockResolvedValue({ models: [], defaults: {} })
    sendUserTurnMock.mockRejectedValue(new Error('网络异常'))
    ;(toastMock.error as any).mockClear()
  })

  afterEach(() => {
    chatTurnActions.reset()
    codexChatProviderActions.resetAll()
    sendMessageMock.mockReset()
    sendUserTurnMock.mockReset()
    getConfigMock.mockReset()
  })

  it('发送失败时回填输入并提示错误', async () => {
    render(<CodexChatPanel />)

    const input = screen.getByTestId('chat-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'hello world' } })

    const form = input.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form!)

    await waitFor(() =>
      expect(sendUserTurnMock).toHaveBeenCalledWith(
        'conv-err',
        expect.objectContaining({ text: 'hello world' })
      )
    )
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('网络异常'))

    const state = useChatTurnStore.getState()
    const slice = chatTurnSelectors.currentSlice(state)
    const lastTurn = slice.turns.at(-1)
    expect(lastTurn?.status).toBe('failed')
    expect(lastTurn?.assistant?.text).toBe('网络异常')

    expect((screen.getByTestId('chat-input') as HTMLTextAreaElement).value).toBe('hello world')
  })
})
