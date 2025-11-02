import type { StateCreator } from 'zustand'
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

export type CodexSessionState = {
  capabilities: CodexChatCapabilities
  models: CodexChatModelOption[]
  overrides: CodexChatConfigOverrides
}

export type CodexProviderStore = {
  providerId: ProviderId
  sessions: Record<string, CodexSessionState>
  setProviderId: (providerId: ProviderId) => void
  setSessionCapabilities: (
    conversationId: string | undefined,
    patch: Partial<CodexChatCapabilities>
  ) => void
  setSessionModels: (conversationId: string | undefined, models: CodexChatModelOption[]) => void
  setSessionOverrides: (
    conversationId: string | undefined,
    patch: Partial<CodexChatConfigOverrides>
  ) => void
  resetSession: (conversationId: string | undefined) => void
  resetAll: () => void
}

export type CodexProviderStoreCreator<TSlice> = StateCreator<
  CodexProviderStore,
  [['zustand/devtools', never], ['zustand/immer', never], ['zustand/subscribeWithSelector', never]],
  [],
  TSlice
>

export const DEFAULT_SESSION_KEY = '__default__'
export const DEFAULT_PROVIDER_ID: ProviderId = 'codex'
