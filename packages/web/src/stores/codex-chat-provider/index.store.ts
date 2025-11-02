import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { subscribeWithSelector } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

import type {
  CodexProviderStore,
  CodexChatCapabilities,
  CodexChatConfigOverrides,
  CodexChatModelOption,
  CodexSessionState
} from './types'
import { DEFAULT_SESSION_KEY } from './types'
import { createCoreSlice } from './slices/core.slice'
import { createActionsSlice } from './slices/actions.slice'
import { emptySession, sessionKey } from './utils'

export const useCodexChatProviderStore = create<CodexProviderStore>()(
  devtools(
    subscribeWithSelector(
      immer((...args) => ({
        ...createCoreSlice(...args),
        ...createActionsSlice(...args)
      }))
    ),
    { name: 'CodexChatProviderStore' }
  )
)

export const codexChatProviderActions = {
  setProviderId(providerId: CodexProviderStore['providerId']) {
    useCodexChatProviderStore.getState().setProviderId(providerId)
  },
  setCapabilities(conversationId: string | undefined, patch: Partial<CodexChatCapabilities>) {
    useCodexChatProviderStore.getState().setSessionCapabilities(conversationId, patch)
  },
  setModels(conversationId: string | undefined, models: CodexChatModelOption[]) {
    useCodexChatProviderStore.getState().setSessionModels(conversationId, models)
  },
  setOverrides(conversationId: string | undefined, patch: Partial<CodexChatConfigOverrides>) {
    useCodexChatProviderStore.getState().setSessionOverrides(conversationId, patch)
  },
  resetSession(conversationId: string | undefined) {
    useCodexChatProviderStore.getState().resetSession(conversationId)
  },
  resetAll() {
    useCodexChatProviderStore.getState().resetAll()
  }
}

export const getCodexSessionState = (
  state: CodexProviderStore,
  conversationId?: string
): CodexSessionState => state.sessions[sessionKey(conversationId)] ?? emptySession()

export const useCodexSessionState = (conversationId?: string) =>
  useCodexChatProviderStore((state) => getCodexSessionState(state, conversationId))

export type {
  CodexChatCapabilities,
  CodexChatModelOption,
  CodexChatConfigOverrides,
  CodexSessionState
} from './types'
