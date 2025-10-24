import { rxRequest, toHttpError } from '@/lib/request'
import type { AskForApproval } from '@/lib/codex-types/AskForApproval'
import type { SandboxMode } from '@/lib/codex-types/SandboxMode'

export type ConversationListItem = {
  path: string
  preview: string
  timestamp: string
  model?: string | null
  conversationId?: string | null
  parentId?: string | null
  rootId?: string | null
  depth?: number
  createdAt?: string | null
  turns?: number | null
}

export type ChatHistoryItem = {
  role: 'user' | 'assistant' | 'reasoning'
  text: string
  reasoning?: string | null
}

export type ConversationSummary = ConversationListItem & {
  id?: string | null
}

export type ChatConfigResponse = {
  models: Array<{
    id: string
    model: string
    displayName: string
    description?: string
    isDefault?: boolean
    defaultReasoningEffort?: string | null
    supportedReasoningEfforts?: string[]
  }>
  defaults: {
    model?: string | null
    approvalPolicy?: AskForApproval | null
    sandboxMode?: SandboxMode | null
  }
}

export type ResumeSandboxConfig = {
  mode: string
  networkAccess?: boolean | null
  excludeTmpdirEnvVar?: boolean | null
  excludeSlashTmp?: boolean | null
  writableRoots?: string[] | null
}

export type ResumeConfigSnapshot = {
  model?: string | null
  approvalPolicy?: string | null
  sandbox?: ResumeSandboxConfig | null
  cwd?: string | null
  effort?: string | null
  summary?: string | null
  environment?: unknown
  overrides?: {
    model?: string | null
    approvalPolicy?: string | null
    sandboxMode?: string | null
    config?: Record<string, unknown> | null
  } | null
}

export type ResumeConversationResponse = {
  conversationId: string
  history?: ChatHistoryItem[]
  // 可选：服务器直接返回归一化后的 chat.* 事件（便于前端在 resume 时重建 steps）
  events?: Array<{ method: string; params?: Record<string, unknown> | null }>
  config?: ResumeConfigSnapshot | null
}

export type NewConversationOverrides = {
  model?: string
  approvalPolicy?: AskForApproval
  sandboxMode?: SandboxMode
}

export const chatApi = {
  async newConversation(overrides?: NewConversationOverrides): Promise<{ conversationId: string }> {
    const payload: Record<string, unknown> = {}
    if (overrides?.model) payload.model = overrides.model
    if (overrides?.approvalPolicy) payload.approvalPolicy = overrides.approvalPolicy
    if (overrides?.sandboxMode) payload.sandboxMode = overrides.sandboxMode
    try {
      // 会话创建采用更短超时 + 一次重试，避免卡住
      const res = await rxRequest<{ conversationId: string }>({
        method: 'POST',
        url: `/api/chat/conversations`,
        data: Object.keys(payload).length > 0 ? payload : undefined,
        timeoutMs: 15_000,
        retries: 1,
        backoffMs: 800
      })
      return res.data
    } catch (e) {
      throw toHttpError(e, 'newConversation failed')
    }
  },
  async debugCodex(params?: { limit?: number; includeChat?: boolean }) {
    try {
      const res = await rxRequest<{ events?: Array<{ method: string; params?: any }> } | null>({
        method: 'GET',
        url: `/debug/codex`,
        params: {
          limit: params?.limit ?? 500,
          includeChat: params?.includeChat ?? true
        },
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data ?? { events: [] }
    } catch (e) {
      throw toHttpError(e, 'debugCodex failed')
    }
  },
  async getConfig(): Promise<ChatConfigResponse> {
    try {
      const res = await rxRequest<ChatConfigResponse>({
        method: 'GET',
        url: `/api/chat/config`,
        timeoutMs: 10_000,
        retries: 0
      })
      return res.data
    } catch (e) {
      throw toHttpError(e, 'getConfig failed')
    }
  },
  async checkVibeLink(params: { conversationId?: string | null; path?: string | null }) {
    try {
      const res = await rxRequest<{
        associated: boolean
        projectId?: string
        taskId?: string
        projectName?: string
        taskTitle?: string
      }>({
        method: 'POST',
        url: `/api/chat/vibe-link`,
        data: {
          conversationId: params.conversationId ?? undefined,
          path: params.path ?? undefined
        },
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data
    } catch (e) {
      throw toHttpError(e, 'checkVibeLink failed')
    }
  },
  async sendMessage(conversationId: string, text: string) {
    try {
      // 发送采用较长超时（后端会推流），但若网络异常仍可重试一次
      const res = await rxRequest({
        method: 'POST',
        url: `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
        data: { text },
        timeoutMs: 60_000,
        retries: 1,
        backoffMs: 800
      })
      // 一些实现返回 202 Accepted，这里不视为错误
      return res.data
    } catch (e: any) {
      // 若服务端返回 202/204 等，无 data，不当作失败
      throw toHttpError(e, 'sendMessage failed')
    }
  },
  async interrupt(conversationId: string) {
    try {
      await rxRequest({
        method: 'POST',
        url: `/api/chat/conversations/${encodeURIComponent(conversationId)}/interrupt`,
        timeoutMs: 15_000,
        retries: 0
      })
    } catch (e) {
      throw toHttpError(e, 'interrupt failed')
    }
  },
  async resumeConversation(): Promise<ResumeConversationResponse | null> {
    try {
      const res = await rxRequest<ResumeConversationResponse>({
        method: 'POST',
        url: `/api/chat/conversations/resume`,
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data
    } catch (e: any) {
      // 404 视作无可恢复会话；axios 会在 toHttpError 时带上 HTTP_404
      if (e?.response?.status === 404) return null
      throw toHttpError(e, 'resume failed')
    }
  },
  async resumeByConversationId(
    conversationId: string
  ): Promise<ResumeConversationResponse> {
    try {
      const res = await rxRequest<ResumeConversationResponse>({
        method: 'POST',
        url: `/api/chat/conversations/resume`,
        data: { conversationId },
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data
    } catch (e) {
      throw toHttpError(e, 'resumeByConversationId failed')
    }
  },
  async getConversation(conversationId: string) {
    try {
      const res = await rxRequest<{ conversation: ConversationSummary } | null>({
        method: 'GET',
        url: `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data?.conversation ?? null
    } catch (e: any) {
      if (e?.response?.status === 404) return null
      throw toHttpError(e, 'getConversation failed')
    }
  },
  async listConversations(params?: { pageSize?: number; cursor?: string }) {
    try {
      const res = await rxRequest<{ items: ConversationListItem[]; nextCursor?: string | null }>({
        method: 'GET',
        url: `/api/chat/conversations`,
        params,
        timeoutMs: 8_000,
        retries: 0
      })
      return res.data
    } catch (e) {
      throw toHttpError(e, 'listConversations failed')
    }
  },
  async deleteConversation(path: string) {
    try {
      await rxRequest({
        method: 'DELETE',
        url: `/api/chat/conversations`,
        data: { path },
        timeoutMs: 8_000,
        retries: 0
      })
    } catch (e) {
      throw toHttpError(e, 'deleteConversation failed')
    }
  }
}
