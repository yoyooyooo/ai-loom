import React, { useMemo, useState, useCallback } from 'react'
import type { TurnStep } from '../../stores/chat-turns'
import { StepIcon, StepCardProps, stepStatusBadge, TagsRow } from './common'
import { getExecOutput, hasExecOutput } from '../../stores/exec-output-vault'
import { chatApi } from '@/features/codex-chat/services/api'
import { useChatTurnStore } from '../../stores/chat-turns'

function buildExecTitle(step: TurnStep): string {
  const command = Array.isArray(step.meta?.command)
    ? (step.meta?.command as string[]).map((part) => String(part))
    : undefined
  const head = command?.[0] || ''
  const flag = command?.[1] || ''
  const isShellWrapper = /(?:^|\/)(?:ba?sh|zsh|sh)$/.test(head) && (flag === '-lc' || flag === '-c')
  const shellScript =
    isShellWrapper && command && command.length >= 3 ? command.slice(2).join('\n').trim() : ''
  const detectionSource = shellScript || (command ? command.join('\n') : String(step.title || ''))
  const isInternalApplyPatch = Array.isArray(command)
    ? command.some((part) => typeof part === 'string' && part.includes('--codex-run-as-apply-patch'))
    : false
  const isPatch =
    !isInternalApplyPatch &&
    (/apply_patch|applypatch|git\s+apply/i.test(detectionSource) ||
      /\*\*\*\s+Begin Patch/.test(detectionSource))
  if (isPatch) {
    try {
      const m = detectionSource.match(/\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)/)
      const headPath = m ? m[1].trim() : ''
      const name = headPath ? headPath.replace(/\/+$/g, '').split('/').pop() || headPath : ''
      return name ? `patch ${name}` : 'patch (apply_patch)'
    } catch {
      return 'patch (apply_patch)'
    }
  }
  const fallback = command ? command.join(' ') : String(step.title || '')
  const base = (shellScript || '').trim() ? shellScript : fallback
  const firstLine = base.replace(/\r/g, '').split(/\n/)[0] || ''
  if (!firstLine) return 'exec'
  if (shellScript) {
    return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
  }
  return firstLine
}

function ExecDetails({ step }: { step: TurnStep }) {
  const args = (() => {
    const cmd = Array.isArray(step.meta?.command) ? step.meta.command.join(' ') : ''
    const cwd = typeof step.meta?.cwd === 'string' ? step.meta.cwd : ''
    return [cmd || '', cwd ? `(cwd=${cwd})` : ''].filter(Boolean).join('\n') || '(empty)'
  })()
  const out = (() => {
    const body = String(step.body || '').trim()
    const stdout = typeof step.meta?.stdout === 'string' ? step.meta.stdout : ''
    const stderr = typeof step.meta?.stderr === 'string' ? step.meta.stderr : ''
    return body || [stdout, stderr].filter(Boolean).join('\n')
  })()
  return (
    <div className="mt-1 space-y-1 max-h-[200px] overflow-auto pr-1">
      <div>
        <div className="text-xs text-muted-foreground">入参</div>
        <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{args}</pre>
      </div>
      <div className="my-1 border-t border-border" />
      <div>
        <div className="text-xs text-muted-foreground">输出</div>
        {out ? (
          <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{out}</pre>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
        )}
      </div>
    </div>
  )
}

export function ExecStepCard({ step }: StepCardProps) {
  const [showFull, setShowFull] = useState(false)
  const vaultKey = useMemo(() => String((step as any)?.meta?.callId || step.id), [step])
  const blobId = useMemo(() => {
    try {
      const v = (step as any)?.meta?.outputBlobId
      return typeof v === 'string' && v ? v : undefined
    } catch {
      return undefined
    }
  }, [step])
  const canShowFull = useMemo(() => {
    const truncated = Boolean((step as any)?.meta?.truncated)
    if (!truncated) return false
    return hasExecOutput(vaultKey) || typeof blobId === 'string'
  }, [step, vaultKey, blobId])
  const conversationId = useChatTurnStore((s) => s.conversationId)
  const ensureFullLoaded = useCallback(async () => {
    if (hasExecOutput(vaultKey)) return true
    if (!blobId || !conversationId) return false
    try {
      const text = await chatApi.getTurnOutput(conversationId, blobId)
      // 直接放入 vault；延迟由组件状态驱动
      if (typeof text === 'string' && text) {
        // 为避免循环依赖，这里动态引入 append
        const mod = await import('../../stores/exec-output-vault')
        mod.appendExecOutput(vaultKey, text)
        return true
      }
    } catch {
      // ignore
    }
    return false
  }, [blobId, conversationId, vaultKey])
  const onToggle = useCallback(async () => {
    if (!showFull) {
      // 打开前尝试加载
      await ensureFullLoaded()
    }
    setShowFull((v) => !v)
  }, [showFull, ensureFullLoaded])
  const full = useMemo(() => (showFull ? getExecOutput(vaultKey) || '' : ''), [showFull, vaultKey])
  return (
    <details className="border-b border-border pb-1">
      <summary className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} step={step} />
        <span className="truncate">{buildExecTitle(step)}</span>
        {stepStatusBadge(step.status)}
      </summary>
      <TagsRow step={step} />
      <ExecDetails step={step} />
      {canShowFull ? (
        <div className="mt-1">
          <button type="button" onClick={onToggle} className="text-xs text-primary hover:underline">
            {showFull ? '收起完整输出' : '查看完整输出（可能很长）'}
          </button>
          {showFull ? (
            <pre className="mt-1 max-h-[320px] overflow-auto whitespace-pre-wrap wrap-break-word text-xs">
              {full || '(无)'}
            </pre>
          ) : null}
        </div>
      ) : null}
    </details>
  )
}
