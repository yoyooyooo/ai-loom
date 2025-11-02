import type { CodexProviderStore, CodexProviderStoreCreator } from '../types'
import { DEFAULT_SESSION_KEY } from '../types'
import { emptySession, mergeCapabilities, withSession } from '../utils'

type Slice = Pick<
  CodexProviderStore,
  | 'setProviderId'
  | 'setSessionCapabilities'
  | 'setSessionModels'
  | 'setSessionOverrides'
  | 'resetSession'
  | 'resetAll'
>

export const createActionsSlice: CodexProviderStoreCreator<Slice> = (set) => ({
  setProviderId: (providerId) =>
    set(() => ({
      providerId,
      sessions: {
        [DEFAULT_SESSION_KEY]: emptySession()
      }
    })),
  setSessionCapabilities: (conversationId, patch) =>
    set((state) => ({
      sessions: withSession(
        conversationId,
        (session) => ({
          ...session,
          capabilities: mergeCapabilities(session.capabilities, patch)
        }),
        state.sessions
      )
    })),
  setSessionModels: (conversationId, models) =>
    set((state) => ({
      sessions: withSession(
        conversationId,
        (session) => ({
          ...session,
          models: Array.isArray(models) ? models : []
        }),
        state.sessions
      )
    })),
  setSessionOverrides: (conversationId, patch) =>
    set((state) => ({
      sessions: withSession(
        conversationId,
        (session) => ({
          ...session,
          overrides: {
            ...session.overrides,
            ...(patch ?? {})
          }
        }),
        state.sessions
      )
    })),
  resetSession: (conversationId) =>
    set((state) => ({
      sessions: withSession(conversationId, () => emptySession(), state.sessions)
    })),
  resetAll: () =>
    set(() => ({
      sessions: {
        [DEFAULT_SESSION_KEY]: emptySession()
      }
    }))
})
