import type { EventMsg } from '@/lib/codex-types/EventMsg'
import type { RateLimitSnapshot } from '@/lib/codex-types/RateLimitSnapshot'
import type { AuthStatusChangeNotification } from '@/lib/codex-types/AuthStatusChangeNotification'

// Generic JSON-RPC 2.0 notification envelope
export type JsonRpcNotification<T = unknown> = {
  jsonrpc: '2.0'
  method: string
  params: T
}

export type CodexSessionConfiguredPayload = {
  provider: string
  sessionId: string
  conversationId: string
  model: string
  reasoningEffort?: string | null
  historyLogId?: number | bigint
  historyEntryCount?: number
  rolloutPath: string
  initialMessages?: EventMsg[] | null
  [key: string]: any
}

export type CodexAuthStatusChangePayload = {
  provider: string
  conversationId?: string
  authMethod?: AuthStatusChangeNotification['authMethod']
  [key: string]: any
}

export type CodexRateLimitPayload = {
  provider: string
  conversationId?: string
  rateLimits?: RateLimitSnapshot | null
  [key: string]: any
}

export type CodexRuntimeEventPayload = {
  provider?: string
  conversationId?: string
  msg?: EventMsg
  id?: string
  [key: string]: any
}

export type CodexEventMethod =
  | 'codex/sessionConfigured'
  | 'codex/authStatusChange'
  | 'codex/account/rateLimits/updated'
  | `codex/event/${string}`

export function isCodexEventMethod(method: string): method is CodexEventMethod {
  return (
    method === 'codex/sessionConfigured' ||
    method === 'codex/authStatusChange' ||
    method === 'codex/account/rateLimits/updated' ||
    method.startsWith('codex/event/')
  )
}

export type CodexNotification =
  | JsonRpcNotification<CodexSessionConfiguredPayload>
  | JsonRpcNotification<CodexAuthStatusChangePayload>
  | JsonRpcNotification<CodexRateLimitPayload>
  | JsonRpcNotification<CodexRuntimeEventPayload>
