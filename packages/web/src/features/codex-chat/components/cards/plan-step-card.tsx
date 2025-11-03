import React from 'react'
import { StepIcon, StepCardProps, stepStatusBadge } from './common'
import { CheckCircle2, Loader2, Circle } from 'lucide-react'

type PlanItem = { step?: string; status?: string }

function StatusIcon({ status }: { status?: string }) {
  const cls = 'size-3.5 shrink-0'
  const s = String(status || '').toLowerCase()
  if (s === 'completed') return <CheckCircle2 className={`${cls} text-emerald-500`} />
  if (s === 'in_progress' || s === 'in-progress')
    return <Loader2 className={`${cls} text-blue-500 animate-spin`} />
  return <Circle className={`${cls} text-muted-foreground opacity-60`} />
}

export function PlanStepCard({ step }: StepCardProps) {
  const plan: PlanItem[] = Array.isArray(step?.meta?.plan) ? step.meta.plan : []

  // 兼容旧 body 文本（以符号开头的行），仅在缺少结构化 plan 时回退
  let fallbackLines: string[] = []
  if (!plan.length) {
    const raw = String(step.body || '')
    fallbackLines = raw
      .replace(/\r/g, '')
      .split(/\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  return (
    <div className="border-b border-border pb-1">
      <div className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} />
        <span className="truncate">{step.title || 'Plan 更新'}</span>
        {stepStatusBadge(step.status, { hideStreaming: true })}
      </div>
      {plan.length > 0 ? (
        <ul className="mt-1 pl-3 space-y-1">
          {plan.map((it, idx) => (
            <li key={`${step.id}-plan-${idx}`} className="flex items-center gap-2 text-xs">
              <StatusIcon status={it?.status} />
              <span className="whitespace-pre-wrap wrap-break-word">
                {it?.step || `Step ${idx + 1}`}
              </span>
            </li>
          ))}
        </ul>
      ) : fallbackLines.length > 0 ? (
        <ul className="mt-1 pl-3 space-y-1">
          {fallbackLines.map((ln, idx) => (
            <li key={`${step.id}-planfb-${idx}`} className="flex items-center gap-2 text-xs">
              {/* 简单推断图标 */}
              {/^✔/.test(ln) ? (
                <CheckCircle2 className="size-3.5 text-emerald-500" />
              ) : /^(…|\.)/.test(ln) ? (
                <Loader2 className="size-3.5 text-blue-500 animate-spin" />
              ) : (
                <Circle className="size-3.5 text-muted-foreground opacity-60" />
              )}
              <span className="whitespace-pre-wrap wrap-break-word">
                {ln.replace(/^[✔…·.\s]+/, '')}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
