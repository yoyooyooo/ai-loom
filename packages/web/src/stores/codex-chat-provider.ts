import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { AskForApproval } from '@/lib/codex-types/AskForApproval'
import type { SandboxMode } from '@/lib/codex-types/SandboxMode'

export type ProviderId = 'codex'

export type CodexChatCapabilities = {
  providerId: ProviderId
  version?: string
  features: {
    patch: boolean
    exec: boolean
    modelsList: boolean
    rateLimits: boolean
    auth: boolean
    images?: boolean
    toolCalls?: boolean
  }
  defaults?: {
    model?: string
    approvalPolicy?: AskForApproval
    sandboxMode?: SandboxMode
  }
  model?: string
  authenticated?: boolean
  rateLimits?: {
    remaining?: number
    resetAt?: string
  }
  extra?: Record<string, unknown>
}

export type CodexChatModelOption = {
  id: string
  model: string
  displayName: string
  description?: string
  isDefault?: boolean
  defaultReasoningEffort?: string | null
  supportedReasoningEfforts?: string[]
}

export type CodexChatConfigOverrides = {
  model?: string
  approvalPolicy?: AskForApproval
  sandboxMode?: SandboxMode
}

type CodexSessionState = {
  capabilities: CodexChatCapabilities
  models: CodexChatModelOption[]
  overrides: CodexChatConfigOverrides
}

type CodexProviderStoreState = {
  providerId: ProviderId
  sessions: Record<string, CodexSessionState>
  setProviderId: (providerId: ProviderId) => void
  setSessionCapabilities: (conversationId: string | undefined, patch: Partial<CodexChatCapabilities>) => void
  setSessionModels: (conversationId: string | undefined, models: CodexChatModelOption[]) => void
  setSessionOverrides: (conversationId: string | undefined, patch: Partial<CodexChatConfigOverrides>) => void
  resetSession: (conversationId: string | undefined) => void
  resetAll: () => void
}

const DEFAULT_SESSION_KEY = '__default__'

const baseFeatures = {
  patch: true,
  exec: true,
  modelsList: true,
  rateLimits: true,
  auth: true,
  images: false,
  toolCalls: true
}

const defaultCapabilities = (): CodexChatCapabilities => ({
  providerId: 'codex',
  version: undefined,
  features: { ...baseFeatures },
  defaults: {
    model: undefined,
    approvalPolicy: 'on-request',
    sandboxMode: 'workspace-write'
  },
  model: undefined,
  authenticated: undefined,
  rateLimits: undefined,
  extra: {}
})

const emptySession = (): CodexSessionState => ({
  capabilities: defaultCapabilities(),
  models: [],
  overrides: {}
})

const mergeCapabilities = (
  current: CodexChatCapabilities,
  patch: Partial<CodexChatCapabilities>
): CodexChatCapabilities => ({
  providerId: 'codex',
  version: patch.version ?? current.version,
  features: patch.features ? { ...current.features, ...patch.features } : current.features,
  defaults: patch.defaults
    ? {
        ...current.defaults,
        ...patch.defaults
      }
    : current.defaults,
  model: patch.model ?? current.model,
  authenticated: patch.authenticated ?? current.authenticated,
  rateLimits: patch.rateLimits
    ? {
        ...current.rateLimits,
        ...patch.rateLimits
      }
    : current.rateLimits,
  extra: patch.extra
    ? {
        ...current.extra,
        ...patch.extra
      }
    : current.extra
})

const sessionKey = (conversationId?: string) => conversationId ?? DEFAULT_SESSION_KEY

const withSession = (
  conversationId: string | undefined,
  updater: (session: CodexSessionState) => CodexSessionState,
  state: CodexProviderStoreState
) => {
  const key = sessionKey(conversationId)
  const current = state.sessions[key] ?? emptySession()
  return {
    ...state.sessions,
    [key]: updater(current)
  }
}

export const useCodexChatProviderStore = create<CodexProviderStoreState>()(
  devtools(
    (set) => ({
      providerId: 'codex',
      sessions: {
        [DEFAULT_SESSION_KEY]: emptySession()
      },
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
            state
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
            state
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
            state
          )
        })),
      resetSession: (conversationId) =>
        set((state) => ({
          sessions: withSession(conversationId, () => emptySession(), state)
        })),
      resetAll: () =>
        set(() => ({
          sessions: {
            [DEFAULT_SESSION_KEY]: emptySession()
          }
        }))
    }),
    { name: 'CodexChatProviderStore' }
  )
)
export const codexChatProviderActions = {
  setProviderId(providerId: ProviderId) {
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
  state: CodexProviderStoreState,
  conversationId?: string
): CodexSessionState => state.sessions[sessionKey(conversationId)] ?? emptySession()

export const useCodexSessionState = (conversationId?: string) =>
  useCodexChatProviderStore((state) => getCodexSessionState(state, conversationId))
