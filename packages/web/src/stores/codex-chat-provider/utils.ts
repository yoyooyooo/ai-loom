import type { CodexChatCapabilities, CodexSessionState } from './types'
import { DEFAULT_PROVIDER_ID, DEFAULT_SESSION_KEY } from './types'

const baseFeatures = {
  patch: true,
  exec: true,
  modelsList: true,
  rateLimits: true,
  auth: true,
  images: false,
  toolCalls: true
}

export const defaultCapabilities = (): CodexChatCapabilities => ({
  providerId: DEFAULT_PROVIDER_ID,
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

export const emptySession = (): CodexSessionState => ({
  capabilities: defaultCapabilities(),
  models: [],
  overrides: {}
})

export const sessionKey = (conversationId?: string) => conversationId ?? DEFAULT_SESSION_KEY

export const mergeCapabilities = (
  current: CodexChatCapabilities,
  patch: Partial<CodexChatCapabilities>
): CodexChatCapabilities => ({
  providerId: DEFAULT_PROVIDER_ID,
  version: patch.version ?? current.version,
  features: patch.features ? { ...current.features, ...patch.features } : current.features,
  defaults: patch.defaults ? { ...current.defaults, ...patch.defaults } : current.defaults,
  model: patch.model ?? current.model,
  authenticated: patch.authenticated ?? current.authenticated,
  rateLimits: patch.rateLimits
    ? { ...current.rateLimits, ...patch.rateLimits }
    : current.rateLimits,
  extra: patch.extra ? { ...current.extra, ...patch.extra } : current.extra
})

export const withSession = (
  conversationId: string | undefined,
  updater: (session: CodexSessionState) => CodexSessionState,
  sessions: Record<string, CodexSessionState>
) => {
  const key = sessionKey(conversationId)
  const current = sessions[key] ?? emptySession()
  return {
    ...sessions,
    [key]: updater(current)
  }
}
