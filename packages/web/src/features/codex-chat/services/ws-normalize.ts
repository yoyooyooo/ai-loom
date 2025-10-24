import type { CodexRuntimeEventPayload } from '@/lib/ws/types'
import type { EventMsg } from '@/lib/codex-types/EventMsg'
import { codexChatProviderActions } from '@/stores/codex-chat-provider'

export type NormalizedChatEvent = { method: string; params: any } | null

const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : undefined

export function decodeBase64Text(chunk?: string): string {
  if (!chunk || typeof chunk !== 'string') return ''
  try {
    if (typeof atob === 'function') {
      const binary = atob(chunk)
      if (textDecoder) {
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        return textDecoder.decode(bytes)
      }
      return binary
    }
    // Node 环境
    const nodeBuffer = (globalThis as any)?.Buffer
    if (nodeBuffer && typeof nodeBuffer.from === 'function') {
      return nodeBuffer.from(chunk, 'base64').toString('utf8')
    }
  } catch {}
  return ''
}

export function normalizeCodexRuntimeEvent(payload: CodexRuntimeEventPayload): NormalizedChatEvent {
  const msg = payload?.msg as EventMsg | undefined
  if (!msg || typeof msg !== 'object' || typeof (msg as any).type !== 'string') return null
  const conversationId = typeof payload?.conversationId === 'string' ? payload.conversationId : undefined
  const baseParams: any = conversationId ? { conversationId } : {}
  const m = msg as any
  switch (msg.type) {
    case 'task_started':
      return { method: 'chat.turn.started', params: { ...baseParams, modelContextWindow: m.model_context_window } }
    case 'agent_message_delta':
      return { method: 'chat.message.delta', params: { ...baseParams, delta: m.delta ?? '' } }
    case 'agent_message': {
      const text = typeof m.message === 'string' ? m.message : ''
      const special = text.trim() === 'Compact task completed' ? 'compact_done' : undefined
      return { method: 'chat.message.completed', params: { ...baseParams, text, special } }
    }
    case 'agent_reasoning_raw_content':
      return null
    case 'agent_reasoning_delta':
      return { method: 'chat.reasoning.delta', params: { ...baseParams, delta: m.delta ?? '' } }
    case 'agent_reasoning':
      return { method: 'chat.reasoning.end', params: { ...baseParams, text: m.text ?? '' } }
    case 'agent_reasoning_section_break':
      return { method: 'chat.reasoning.section_break', params: { ...baseParams } }
    case 'exec_command_begin':
      return {
        method: 'chat.tool.exec.begin',
        params: { ...baseParams, callId: m.call_id, command: Array.isArray(m.command) ? m.command : [], cwd: typeof m.cwd === 'string' ? m.cwd : '' }
      }
    case 'exec_command_output_delta':
      return {
        method: 'chat.tool.exec.output',
        params: { ...baseParams, callId: m.call_id, stream: m.stream, chunk: m.chunk, text: decodeBase64Text(m.chunk) }
      }
    case 'exec_command_end':
      return {
        method: 'chat.tool.exec.end',
        params: {
          ...baseParams,
          callId: m.call_id,
          stdout: m.stdout,
          stderr: m.stderr,
          exitCode: m.exit_code,
          duration: m.duration,
          aggregatedOutput: m.aggregated_output,
          formattedOutput: m.formatted_output
        }
      }
    case 'patch_apply_begin': {
      const changes = (m.changes ?? {}) as Record<string, unknown>
      const entries = Object.entries(changes)
      const firstPath = entries.length > 0 ? entries[0][0] : undefined
      return {
        method: 'chat.tool.patch.begin',
        params: { ...baseParams, callId: m.call_id, autoApproved: !!m.auto_approved, files: entries.length, firstPath, changes }
      }
    }
    case 'patch_apply_end':
      return { method: 'chat.tool.patch.end', params: { ...baseParams, callId: m.call_id, success: !!m.success, stdout: m.stdout, stderr: m.stderr } }
    case 'mcp_tool_call_begin': {
      const invocation = m.invocation || {}
      return { method: 'chat.tool.mcp.begin', params: { ...baseParams, callId: m.call_id, server: invocation.server, tool: invocation.tool, arguments: invocation.arguments ?? undefined } }
    }
    case 'mcp_tool_call_end': {
      const invocation = m.invocation || {}
      return { method: 'chat.tool.mcp.end', params: { ...baseParams, callId: m.call_id, server: invocation.server, tool: invocation.tool, arguments: invocation.arguments ?? undefined, result: m.result } }
    }
    case 'user_message':
      return { method: 'chat.info.user_message', params: { ...baseParams, text: m.message ?? '', kind: m.kind ?? null } }
    case 'web_search_begin':
      return { method: 'chat.info.web_search.begin', params: { ...baseParams, callId: m.call_id } }
    case 'web_search_end':
      return { method: 'chat.info.web_search.end', params: { ...baseParams, callId: m.call_id, query: m.query ?? '' } }
    case 'task_complete':
      return { method: 'chat.turn.complete', params: { ...baseParams } }
    case 'turn_aborted':
      return { method: 'chat.message.aborted', params: { ...baseParams, reason: m.reason } }
    case 'stream_error':
    case 'error':
      return { method: 'chat.message.failed', params: { ...baseParams, error: { message: m.message ?? '执行失败' } } }
    case 'token_count': {
      const patch = { providerId: 'codex' as const, extra: { tokenCount: m } }
      codexChatProviderActions.setCapabilities(undefined, patch)
      if (conversationId) codexChatProviderActions.setCapabilities(conversationId, patch)
      return null
    }
    case 'turn_diff':
      return { method: 'chat.info.turn_diff', params: { ...baseParams, diff: typeof m.unified_diff === 'string' ? m.unified_diff : '' } }
    case 'plan_update':
      return { method: 'chat.info.plan_update', params: { ...baseParams, plan: Array.isArray(m.plan) ? m.plan : [], explanation: typeof m.explanation === 'string' ? m.explanation : '' } }
    case 'exec_approval_request':
      return { method: 'chat.info.approval.exec', params: { ...baseParams, callId: m.call_id, command: Array.isArray(m.command) ? m.command : [], cwd: typeof m.cwd === 'string' ? m.cwd : '', reason: typeof m.reason === 'string' ? m.reason : undefined } }
    case 'apply_patch_approval_request':
      return { method: 'chat.info.approval.patch', params: { ...baseParams, callId: m.call_id, reason: typeof m.reason === 'string' ? m.reason : undefined, grantRoot: typeof m.grant_root === 'string' ? m.grant_root : undefined, changeCount: m.changes ? Object.keys(m.changes).length : 0 } }
    case 'background_event':
      return { method: 'chat.info.background', params: { ...baseParams, message: typeof m.message === 'string' ? m.message : '' } }
    case 'view_image_tool_call':
      return { method: 'chat.info.view_image', params: { ...baseParams, callId: m.call_id, path: m.path } }
    case 'conversation_path':
      return { method: 'chat.info.conversation_path', params: { ...baseParams, path: m.path } }
    case 'entered_review_mode':
      return { method: 'chat.info.review.entered', params: { ...baseParams } }
    case 'exited_review_mode':
      return { method: 'chat.info.review.exited', params: { ...baseParams } }
    default:
      return null
  }
}
