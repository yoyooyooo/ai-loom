import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { chatApi } from '../services/api'
import type { ChatConfigResponse } from '../services/api'
import { subscribeChatEvents } from '../services/ws'
import { useChatTurnStore, chatTurnActions } from '../stores/chat-turns'
import { TurnsPanel } from './turns-panel'
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

type CodexChatPanelProps = {
  className?: string
  onConversationCreated?: (conversationId: string) => void
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
  const { conversationId, generating, turns } = useChatTurnStore((state) => ({
    conversationId: state.conversationId,
    generating: state.generating,
    turns: state.turns
  }))
  const [stopping, setStopping] = useState(false)
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
  const configCache = useRef<ChatConfigResponse | null>(null)

  useEffect(() => {
    const off = subscribeChatEvents()
    chatTrace('chatPanel.mounted', {})
    // 初始化：尽力恢复 conversationId（用于刷新后“停止生成”仍可工作），不做自动 resume
    try {
      const saved =
        typeof window !== 'undefined' ? localStorage.getItem('chat.conversationId') : null
      // 若路由上已有会话 ID，则以路由为准，避免短暂覆盖导致 UI 闪烁
      if (saved && !routeConversationKey) chatTurnActions.setConversationId(saved)
    } catch {}
    // 仅挂载订阅，不在挂载时 reset，以避免切换面板或热更导致历史被清空
    return () => off()
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
          configCache.current = res
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

  async function ensureConversation() {
    chatTrace('chatPanel.ensureConversation', { conversationId })
    if (conversationId) return conversationId
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
    chatTurnActions.setConversationId(newId)

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
      onConversationCreated?.(newId)
    } catch (error) {
      console.warn('[chat] onConversationCreated error', error)
    }

    return newId
  }

  async function onSend() {
    const t = text.trim()
    if (!t) return
    chatTrace('chatPanel.onSend', { textPreview: t.slice(0, 60) })
    setText('')
    chatTurnActions.addUserTurn(t)
    const cid = await ensureConversation().catch((e) => {
      const msg = (e as Error)?.message || '创建会话失败'
      chatTurnActions.failAssistant(msg)
      chatTurnActions.completeTurn()
      chatTrace('chatPanel.ensureConversation.fail', { error: (e as Error)?.message })
      throw e
    })
    try {
      await chatApi.sendMessage(cid, t)
      chatTrace('chatPanel.sendMessage.success', { conversationId: cid })
    } catch (e) {
      const msg = (e as Error)?.message
      chatTurnActions.failAssistant(msg)
      chatTurnActions.completeTurn()
      chatTrace('chatPanel.sendMessage.fail', {
        conversationId: cid,
        error: (e as Error)?.message
      })
    }
  }

  async function onStop() {
    if (!conversationId) return
    try {
      setStopping(true)
      // 等待 Codex 确认中止本轮，避免后续立即新轮被“注入旧轮”
      await chatApi.interrupt(conversationId, { awaitTurnAborted: true, timeoutMs: 15_000 })
      chatTrace('chatPanel.interrupt', { conversationId })
    } finally {
      setStopping(false)
      chatTurnActions.abortAssistant()
      chatTurnActions.completeTurn()
    }
  }
  const composer = (
    <>
      <textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          }
        }}
        placeholder={generating ? '生成中，等待完成或停止...' : '输入消息...'}
        className="min-h-[120px] w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        disabled={generating}
      />
      <div className="flex flex-wrap items-end gap-3">
        <ConfigSelect
          label="模型"
          placeholder="跟随默认"
          value={selectedModel}
          options={modelOptions}
          onChange={(value) =>
            codexChatProviderActions.setOverrides(conversationId, {
              model: value || undefined
            })
          }
          disabled={generating}
        />
        <ConfigSelect
          label="审批策略"
          placeholder="跟随默认"
          value={selectedApproval}
          options={APPROVAL_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label
          }))}
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
          options={SANDBOX_OPTIONS.map((opt) => ({
            value: opt.value,
            label: opt.label
          }))}
          onChange={(value) =>
            codexChatProviderActions.setOverrides(conversationId, {
              sandboxMode: (value as SandboxMode) || undefined
            })
          }
          disabled={generating}
        />
        <CodexChatConfigPanelTrigger />
      </div>
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onSend}
          disabled={!text.trim() || generating}
          className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors disabled:opacity-50"
        >
          发送
        </button>
        {generating ? (
          <button
            onClick={onStop}
            disabled={!conversationId || stopping}
            className="inline-flex items-center justify-center rounded-md border border-input px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {stopping ? '停止中…' : '停止生成'}
          </button>
        ) : null}
      </div>
    </>
  )

  const isEmpty = turns.length === 0
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined

  if (isEmpty) {
    // 在 /chat/:id 路由且消息尚未恢复时，显示占位而非“开始新的对话”
    if (routeConversationKey) {
      return (
        <div className={cn('flex h-full w-full items-center justify-center px-6 py-8', className)}>
          <div className="text-sm text-muted-foreground">正在加载会话...</div>
        </div>
      )
    }
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center px-6 py-8', className)}>
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
    <div className={cn('flex h-full min-h-0 flex-1 flex-col gap-3', className)}>
      <div className="flex-1 min-h-0 overflow-hidden">
        <TurnsPanel />
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
