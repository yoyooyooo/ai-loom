import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { firstValueFrom, from } from 'rxjs'
import { switchMap } from 'rxjs/operators'
import { useParams } from 'react-router-dom'
import { useObservableState } from 'observable-hooks'
import { cn } from '@/lib/utils'
import { chatApi } from '../services/api'
import type { ChatConfigResponse, SendUserTurnRequest } from '../services/api'
import { subscribeChatEvents } from '../services/ws'
import {
  useChatTurnStore,
  chatTurnActions,
  chatTurnSelectors,
  selectConversation
} from '../stores/chat-turns'
import { TurnsPanel } from './turns-panel'
import { MessageInput } from '@/components/ui/message-input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { SlidersHorizontal, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { CodexChatConfigPanelTrigger } from './chat-config-panel'
import {
  codexChatProviderActions,
  getCodexSessionState,
  useCodexChatProviderStore,
  useCodexSessionState
} from '@/stores/codex-chat-provider'
import type { AskForApproval } from '@/lib/codex-types/AskForApproval'
import type { SandboxMode } from '@/lib/codex-types/SandboxMode'
import { chatTrace } from '@/lib/logger'
import { useChatHydrationStore } from '../stores/chat-hydration'
import { ws } from '@/lib/ws/singleton'
import {
  generatingState$,
  getGeneratingSnapshot
} from '@/features/codex-chat/services/generating-aggregator'

const APPROVAL_OPTIONS: Array<{ value: AskForApproval; label: string }> = [
  { value: 'on-request', label: '按需请求 (on-request)' },
  { value: 'on-failure', label: '失败后升级 (on-failure)' },
  { value: 'untrusted', label: '仅信任读操作 (untrusted)' },
  { value: 'never', label: '永不提示 (never)' }
]

const SANDBOX_OPTIONS: Array<{ value: SandboxMode; label: string }> = [
  { value: 'workspace-write', label: '工作区写入 (workspace-write)' },
  { value: 'read-only', label: '只读 (read-only)' },
  { value: 'danger-full-access', label: '完全开放 (danger-full-access)' }
]

export type ConversationCreatedPayload = {
  conversationId: string
  preview?: string
  model?: string | null
  providerId?: string | null
  timestamp?: string
  createdAt?: string
}

type CodexChatPanelProps = {
  className?: string
  onConversationCreated?: (payload: ConversationCreatedPayload) => void
}

const HISTORY_PREVIEW_LIMIT = 140

const buildHistoryPreview = (text: string) => {
  const normalized = text.trim()
  if (!normalized) return ''
  if (normalized.length <= HISTORY_PREVIEW_LIMIT) return normalized
  return `${normalized.slice(0, HISTORY_PREVIEW_LIMIT)}…`
}

export function CodexChatPanel({ className, onConversationCreated }: CodexChatPanelProps = {}) {
  const params = useParams<{ conversationId?: string }>()
  const routeConversationKey = useMemo(() => {
    const seg = params.conversationId
    if (!seg) return undefined
    try {
      return decodeURIComponent(seg)
    } catch {
      return seg
    }
  }, [params.conversationId])
  const [text, setText] = useState('')
  const handleRetry = useCallback(
    (value: string) => {
      if (!value) return
      setText(value)
    },
    [setText]
  )
  const conversationId = useChatTurnStore((state) => state.conversationId)
  const currentSlice = useChatTurnStore(chatTurnSelectors.currentSlice)
  const [globalGeneratingState] = useObservableState(
    () => generatingState$(),
    getGeneratingSnapshot()
  )
  const sessionState = useCodexSessionState(conversationId)
  const providerState = useMemo(
    () => ({
      models: sessionState.models,
      overrides: sessionState.overrides,
      defaults: sessionState.capabilities.defaults ?? {},
      currentModel: sessionState.capabilities.model
    }),
    [sessionState]
  )
  const providerId = sessionState.capabilities.providerId || 'codex'
  const generatingKey = useMemo(() => {
    if (!conversationId) return null
    const keyWithProvider = providerId ? `${providerId}|${conversationId}` : conversationId
    return keyWithProvider
  }, [providerId, conversationId])
  const aggregatedGenerating = useMemo(() => {
    if (!conversationId) return false
    const key = generatingKey
    const byKey = globalGeneratingState.byKey || {}
    if (key && byKey[key]?.generating) return true
    return !!byKey[conversationId]?.generating
  }, [conversationId, generatingKey, globalGeneratingState])
  const generating = aggregatedGenerating || currentSlice.generating
  const turns = currentSlice.turns
  const [stopping, setStopping] = useState(false)
  const configCache = useRef<ChatConfigResponse | null>(null)

  useEffect(() => {
    const off = subscribeChatEvents()
    chatTrace('chatPanel.mounted', {})
    // 初始化：尽力恢复 conversationId（用于刷新后“停止生成”仍可工作），不做自动 resume
    try {
      const saved =
        typeof window !== 'undefined' ? localStorage.getItem('chat.conversationId') : null
      // 若路由上已有会话 ID，则以路由为准，避免短暂覆盖导致 UI 闪烁
      if (saved && !routeConversationKey) selectConversation(saved, { reason: 'local' })
    } catch {}
    // 仅挂载订阅，不在挂载时 reset，以避免切换面板或热更导致历史被清空
    return () => off()
  }, [routeConversationKey])

  // 按会话建立 WS 订阅（稳定持有，避免 gating 空窗）；切换路由键时重建
  useEffect(() => {
    if (!routeConversationKey) return
    const sub = (ws as any)
      .subscribeTopic$('chat', { conversationId: routeConversationKey })
      .subscribe(() => {})
    return () => {
      try {
        sub.unsubscribe()
      } catch {}
    }
  }, [routeConversationKey])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      chatTrace('chatPanel.fetchConfig.start', { conversationId })
      try {
        let res = configCache.current
        if (!res) {
          res = await chatApi.getConfig()
          if (cancelled) return
          if (res?.codexUnavailable) {
            chatTrace('chatPanel.fetchConfig.unavailable', {})
            return
          }
          configCache.current = res
        } else if (res.codexUnavailable) {
          chatTrace('chatPanel.fetchConfig.unavailable.cached', {})
          return
        }
        const mappedModels =
          res?.models?.map((item) => ({
            id: item.id,
            model: item.model,
            displayName: item.displayName,
            description: item.description ?? undefined,
            isDefault: item.isDefault,
            defaultReasoningEffort: item.defaultReasoningEffort ?? null,
            supportedReasoningEfforts: item.supportedReasoningEfforts ?? []
          })) ?? []

        codexChatProviderActions.setModels(undefined, mappedModels)
        codexChatProviderActions.setCapabilities(undefined, {
          defaults: {
            model: res?.defaults?.model ?? undefined,
            approvalPolicy: res?.defaults?.approvalPolicy ?? undefined,
            sandboxMode: res?.defaults?.sandboxMode ?? undefined
          }
        })

        const snapshot = useCodexChatProviderStore.getState()
        const defaultSession = getCodexSessionState(snapshot)
        if (!defaultSession.capabilities.model && res?.defaults?.model) {
          codexChatProviderActions.setCapabilities(undefined, {
            model: res.defaults.model ?? undefined
          })
        }
        if (
          !defaultSession.overrides.model &&
          !defaultSession.overrides.approvalPolicy &&
          !defaultSession.overrides.sandboxMode
        ) {
          codexChatProviderActions.setOverrides(undefined, {
            model: res?.defaults?.model ?? undefined,
            approvalPolicy: res?.defaults?.approvalPolicy ?? undefined,
            sandboxMode: res?.defaults?.sandboxMode ?? undefined
          })
        }

        if (conversationId) {
          codexChatProviderActions.setModels(conversationId, mappedModels)
          codexChatProviderActions.setCapabilities(conversationId, {
            defaults: {
              model: res?.defaults?.model ?? undefined,
              approvalPolicy: res?.defaults?.approvalPolicy ?? undefined,
              sandboxMode: res?.defaults?.sandboxMode ?? undefined
            }
          })

          const refreshed = useCodexChatProviderStore.getState()
          const activeSession = getCodexSessionState(refreshed, conversationId)
          if (!activeSession.capabilities.model && res?.defaults?.model) {
            codexChatProviderActions.setCapabilities(conversationId, {
              model: res.defaults.model ?? undefined
            })
          }
          if (
            !activeSession.overrides.model &&
            !activeSession.overrides.approvalPolicy &&
            !activeSession.overrides.sandboxMode
          ) {
            codexChatProviderActions.setOverrides(conversationId, {
              model: res?.defaults?.model ?? undefined,
              approvalPolicy: res?.defaults?.approvalPolicy ?? undefined,
              sandboxMode: res?.defaults?.sandboxMode ?? undefined
            })
          }
        }
      } catch (error) {
        console.warn('[chat] getConfig failed', error)
        chatTrace('chatPanel.fetchConfig.error', { error: (error as Error)?.message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversationId])

  const selectedModel =
    providerState.overrides.model ??
    providerState.currentModel ??
    providerState.defaults.model ??
    ''
  const selectedApproval =
    providerState.overrides.approvalPolicy ?? providerState.defaults.approvalPolicy ?? ''
  const selectedSandbox =
    providerState.overrides.sandboxMode ?? providerState.defaults.sandboxMode ?? ''

  const modelOptions = useMemo(() => {
    const base =
      providerState.models.map((m) => ({
        value: m.model,
        label: m.displayName ? `${m.displayName}` : m.model,
        hint: m.description
      })) ?? []
    if (selectedModel && !base.some((opt) => opt.value === selectedModel)) {
      base.push({ value: selectedModel, label: selectedModel, hint: undefined })
    }
    return base
  }, [providerState.models, selectedModel])

  async function ensureConversation(): Promise<{ id: string; isNew: boolean }> {
    chatTrace('chatPanel.ensureConversation', { conversationId })
    if (conversationId) return { id: conversationId, isNew: false }
    const storeSnapshot = useCodexChatProviderStore.getState()
    const defaultSession = getCodexSessionState(storeSnapshot)
    const overrides = defaultSession.overrides
    const payload: Record<string, unknown> = {}
    if (overrides.model) payload.model = overrides.model
    if (overrides.approvalPolicy) payload.approvalPolicy = overrides.approvalPolicy
    if (overrides.sandboxMode) payload.sandboxMode = overrides.sandboxMode
    const r = await chatApi.newConversation(payload)
    chatTrace('chatPanel.newConversation', { payload, conversationId: r.conversationId })
    const newId = r.conversationId
    selectConversation(newId, { reason: 'new' })

    codexChatProviderActions.setModels(newId, defaultSession.models)
    codexChatProviderActions.setCapabilities(newId, {
      model: defaultSession.capabilities.model,
      defaults: defaultSession.capabilities.defaults,
      authenticated: defaultSession.capabilities.authenticated,
      rateLimits: defaultSession.capabilities.rateLimits,
      extra: defaultSession.capabilities.extra
    })
    codexChatProviderActions.setOverrides(newId, defaultSession.overrides)

    try {
      // 标记为“新建会话”，跳过首轮 HTTP baseline（对齐 vibe-kanban 的纯流式体验）
      ;(await import('@/features/codex-chat/services/conversation-session')).markConversationNew(
        newId
      )
    } catch (error) {
      console.warn('[chat] markConversationNew error', error)
    }

    return { id: newId, isNew: true }
  }

  async function onSend() {
    if (generating) return
    const rawInput = text
    const trimmed = rawInput.trim()
    if (!trimmed) return

    const handleFailure = (error: unknown, context: 'ensure' | 'send', cid?: string) => {
      const err = error as any
      const status = typeof err?.status === 'number' ? err.status : err?.raw?.response?.status
      const payloadMessage =
        typeof err?.data?.error?.message === 'string' ? err.data.error.message : undefined
      const rawMessage =
        typeof err?.message === 'string' && err.message.trim().length > 0 ? err.message.trim() : ''
      const fallback = context === 'ensure' ? '创建会话失败' : '消息发送失败'
      const finalMessage = (() => {
        if (context === 'send') {
          if (status === 503) {
            return 'Codex 实例正在恢复，请稍后重试'
          }
          if (status === 501) {
            return '当前运行时不支持会话内配置切换，请新建会话后重试'
          }
        }
        if (payloadMessage && payloadMessage.trim().length > 0) return payloadMessage.trim()
        if (rawMessage) return rawMessage
        return fallback
      })()
      chatTurnActions.failAssistant(finalMessage)
      chatTurnActions.completeTurn()
      setText(rawInput)
      toast.error(finalMessage)
      if (context === 'ensure') {
        chatTrace('chatPanel.ensureConversation.fail', { error: rawMessage || fallback })
      } else {
        chatTrace('chatPanel.sendTurn.fail', {
            conversationId: cid,
            error: rawMessage || payloadMessage || fallback,
            status
          })
      }
    }

    chatTrace('chatPanel.onSend', { textPreview: trimmed.slice(0, 60) })
    setText('')
    chatTurnActions.addUserTurn(trimmed)

    let ensured: { id: string; isNew: boolean }
    try {
      ensured = await ensureConversation()
    } catch (error) {
      handleFailure(error, 'ensure')
      return
    }

    const cid = ensured.id

    if (ensured.isNew) {
      const issuedAt = new Date().toISOString()
      onConversationCreated?.({
        conversationId: cid,
        preview: buildHistoryPreview(trimmed),
        model: selectedModel || null,
        providerId: sessionState.capabilities.providerId ?? null,
        timestamp: issuedAt,
        createdAt: issuedAt
      })
    }

    const normalizeOptionalString = (value: string | undefined | null) => {
      if (!value) return undefined
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : undefined
    }
    const modelForSend = normalizeOptionalString(selectedModel) || undefined
    const approvalForSend = normalizeOptionalString(selectedApproval) as
      | AskForApproval
      | undefined
    const sandboxForSend = normalizeOptionalString(selectedSandbox) as SandboxMode | undefined

    const turnPayload: SendUserTurnRequest = {
      text: trimmed
    }
    if (modelForSend) turnPayload.model = modelForSend
    if (approvalForSend) turnPayload.approvalPolicy = approvalForSend
    if (sandboxForSend) turnPayload.sandboxMode = sandboxForSend

    let downgradedToMessage = false

    const sendWithFallback = async () => {
      try {
        const { ws } = await import('@/lib/ws/singleton')
        await firstValueFrom(
          (ws as any)
            .ensureChatReady$(cid, { tail: 128, timeoutMs: 5000 })
            .pipe(switchMap(() => from(chatApi.sendUserTurn(cid, turnPayload))))
        )
      } catch (error) {
        try {
          await chatApi.sendUserTurn(cid, turnPayload)
        } catch (inner) {
          const status =
            typeof (inner as any)?.status === 'number'
              ? (inner as any).status
              : (inner as any)?.raw?.response?.status
          if (status === 501) {
            downgradedToMessage = true
            toast.warning('当前版本暂不支持会话内切换，已按原配置发送')
            await chatApi.sendMessage(cid, trimmed)
          } else {
            throw inner
          }
        }
      }
    }

    try {
      await sendWithFallback()
      chatTrace('chatPanel.sendTurn.success', {
        conversationId: cid,
        downgraded: downgradedToMessage
      })
      if (!downgradedToMessage && modelForSend) {
        codexChatProviderActions.setCapabilities(cid, { model: modelForSend })
      }
      if (downgradedToMessage) {
        chatTrace('chatPanel.sendTurn.degraded', { conversationId: cid })
      }
      // 主动补偿一次会话级 resume，避免偶发实时丢帧造成界面停滞
      try {
        // 使用 convLast 作为游标；after>0 时服务端忽略 tail
        ;(await import('@/lib/ws/singleton')).ws.resumeChat(cid, { tail: 64 })
      } catch {}
    } catch (error) {
      handleFailure(error, 'send', cid)
    }
  }

  async function onStop() {
    if (!conversationId) return
    try {
      setStopping(true)
      // 发送中止请求（不再阻塞等待），由 WS 的 chat.message.aborted 驱动收束
      await chatApi.interrupt(conversationId)
      chatTrace('chatPanel.interrupt', { conversationId })
      // 主动触发一次会话级 resume（tail 少量历史），加速收到 aborted 事件的补偿
      try {
        ;(await import('@/lib/ws/singleton')).ws.resumeChat(conversationId, { tail: 64 })
      } catch {}
    } finally {
      setStopping(false)
      // 不再做乐观收束，等待 chat.message.aborted 或 chat.turn.complete
    }
  }
  const configMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="对话设置">
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[360px] p-3 space-y-3" align="start">
        <ConfigSelect
          label="模型"
          placeholder="跟随默认"
          value={selectedModel}
          options={modelOptions}
          onChange={(value) =>
            codexChatProviderActions.setOverrides(conversationId, { model: value || undefined })
          }
          disabled={generating}
        />
        <ConfigSelect
          label="审批策略"
          placeholder="跟随默认"
          value={selectedApproval}
          options={APPROVAL_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          onChange={(value) =>
            codexChatProviderActions.setOverrides(conversationId, {
              approvalPolicy: (value as AskForApproval) || undefined
            })
          }
          disabled={generating}
        />
        <ConfigSelect
          label="沙箱"
          placeholder="跟随默认"
          value={selectedSandbox}
          options={SANDBOX_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
          onChange={(value) =>
            codexChatProviderActions.setOverrides(conversationId, {
              sandboxMode: (value as SandboxMode) || undefined
            })
          }
          disabled={generating}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const composer = (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSend()
        }}
      >
        <div className="px-0">
          <MessageInput
            value={text}
            onChange={(e) => setText((e.target as HTMLTextAreaElement).value)}
            isGenerating={generating}
            stop={onStop}
            submitOnEnter
            placeholder={generating ? '生成中，等待完成或停止...' : '输入消息...'}
            className="min-h-12"
            leftExtras={configMenu}
          />
        </div>
      </form>
      {/* 发送/停止按钮由 MessageInput 自带，不再重复渲染 */}
    </>
  )

  const isEmpty = turns.length === 0
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined
  const hydrating = useChatHydrationStore((s) =>
    routeConversationKey ? !!s.hydrating[routeConversationKey] : false
  )

  if (isEmpty) {
    // 严格等于握手缓冲窗口：仅当握手期（sync_begin→sync_end）显示“正在加载会话...”
    if (routeConversationKey) {
      if (hydrating) {
        return (
          <div
            className={cn('flex h-full w-full items-center justify-center px-6 py-8', className)}
          >
            <div className="text-sm text-muted-foreground">正在加载会话...</div>
          </div>
        )
      }
      // 非握手期但该会话暂无消息：展示主界面（空 turns）+ 输入区
      return (
        <div className={cn('flex h-full min-h-0 flex-1 flex-col gap-3', className)}>
          <div className="flex-1 min-h-0 overflow-hidden">
            <TurnsPanel onRetry={handleRetry} />
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3">{composer}</div>
        </div>
      )
    }
    return (
      <div
        className={cn(
          'flex h-full w-full flex-col items-center justify-center px-6 py-8',
          className
        )}
      >
        <div className="w-full max-w-3xl space-y-6">
          <div className="text-center">
            <h2 className="text-lg font-medium text-foreground">开始新的对话</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              输入你的问题或指令，系统会自动创建一个新的会话并在左侧历史中展示。
            </p>
          </div>
          <div className="flex flex-col gap-3">{composer}</div>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('relative flex h-full min-h-0 flex-1 flex-col gap-3', className)}>
      {routeConversationKey && hydrating ? (
        <div className="pointer-events-none absolute left-4 top-2 z-10 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <Loader2 className="size-3 animate-spin" /> 正在同步会话…
        </div>
      ) : null}
      <div className="flex-1 min-h-0 overflow-hidden">
        <TurnsPanel onRetry={handleRetry} />
      </div>
      <div className="flex flex-col gap-3 border-t border-border px-4 py-3">{composer}</div>
      {!generating && lastTurn && lastTurn.status === 'failed' ? (
        <div className="px-4 pb-3">
          <button
            onClick={() => {
              const lastUser = lastTurn?.user?.text
              if (lastUser) setText(lastUser)
            }}
            className="text-sm text-primary hover:underline"
          >
            重试（将上次用户消息填回）
          </button>
        </div>
      ) : null}
    </div>
  )
}

export default CodexChatPanel

type ConfigSelectProps = {
  label: string
  value: string
  options: Array<{ value: string; label: string; hint?: string }>
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
  placeholder = '跟随默认',
  disabled
}: ConfigSelectProps) {
  return (
    <label className="flex min-w-[160px] flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value="">{placeholder}</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} title={opt.hint ?? opt.label}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  )
}
