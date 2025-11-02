import React from 'react'
import type { TurnStep } from '../../stores/chat-turns'
import { StepIcon, StepCardProps, stepStatusBadge, TagsRow } from './common'

function McpDetails({ step }: { step: TurnStep }) {
  const argsText = (() => {
    const args = step.meta?.args as any
    try {
      if (typeof args === 'string') return args
      if (args == null) return '(empty)'
      return JSON.stringify(args, null, 2)
    } catch {
      return String(args ?? '(empty)')
    }
  })()
  const resNode = (() => {
    const res = step.meta?.result as any
    try {
      if (typeof res === 'string') {
        const trimmed = res.trim()
        return trimmed ? (
          <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{trimmed}</pre>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
        )
      }
      if (res == null)
        return <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
      return (
        <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">
          {JSON.stringify(res, null, 2)}
        </pre>
      )
    } catch {
      return (
        <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">
          {String(res ?? '')}
        </pre>
      )
    }
  })()
  return (
    <div className="mt-1 space-y-1 max-h-[200px] overflow-auto pr-1">
      <div>
        <div className="text-xs text-muted-foreground">入参</div>
        <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{argsText}</pre>
      </div>
      <div className="my-1 border-t border-border" />
      <div>
        <div className="text-xs text-muted-foreground">输出</div>
        {resNode}
      </div>
    </div>
  )
}

export function McpStepCard({ step }: StepCardProps) {
  const title = (() => {
    const server = String((step.meta?.server ?? '') || '')
    const tool = String((step.meta?.tool ?? '') || '')
    return server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : step.title || 'mcp'
  })()
  return (
    <details className="border-b border-border pb-1">
      <summary className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} />
        <span className="truncate">{title}</span>
        {stepStatusBadge(step.status)}
      </summary>
      <TagsRow step={step} />
      <McpDetails step={step} />
    </details>
  )
}
