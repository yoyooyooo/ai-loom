import React from 'react'
import { StepIcon, StepCardProps, stepStatusBadge, TagsRow } from './common'
import { stripDuplicatedTitle } from '@/features/codex-chat/stores/chat-turns-utils'

export function GenericStepCard({ step }: StepCardProps) {
  const raw = String(step.body || '')
  const contentNode = (() => {
    if (!raw.trim()) return null
    if (step.kind !== 'thinking') {
      return <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">{raw}</pre>
    }
    const titleOnly = String(step.title || '')
      .replace(/^thinking:\s*/i, '')
      .trim()
    const cleaned = titleOnly ? stripDuplicatedTitle(raw, titleOnly) : raw
    return <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">{cleaned}</pre>
  })()

  return (
    <details className="border-b border-border pb-1">
      <summary className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} />
        <span className="truncate">{step.title || ''}</span>
        {stepStatusBadge(step.status)}
      </summary>
      <TagsRow step={step} />
      {contentNode}
    </details>
  )
}
