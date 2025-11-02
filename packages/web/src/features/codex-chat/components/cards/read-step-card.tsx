import React from 'react'
import { StepIcon, StepCardProps, stepStatusBadge } from './common'
import { buildCmdAndCwdArgs, buildReadLikeOutput } from './io-common'

export function ReadStepCard({ step, turn }: StepCardProps) {
  const args = buildCmdAndCwdArgs(step)
  const out = turn ? buildReadLikeOutput(step, turn) : ''
  const file = String((step?.meta as any)?.file || '').trim()
  const start = (step?.meta as any)?.start
  const end = (step?.meta as any)?.end
  const lastName = (p?: string) => {
    try {
      if (!p) return undefined
      const s = String(p).replace(/\/+$/g, '')
      const segs = s.split('/')
      return segs[segs.length - 1] || s
    } catch {
      return undefined
    }
  }
  const name = lastName(file)
  return (
    <details className="border-b border-border pb-1">
      <summary className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} />
        <span className="truncate">
          {name ? (
            <>
              {'Read '}
              <span className="text-primary font-bold">{name}</span>
              {typeof start === 'number' &&
              typeof end === 'number' &&
              start >= 1 &&
              end >= start ? (
                <span className="text-muted-foreground">
                  {' '}
                  {' (lines: '}
                  {start}-{end}
                  {')'}{' '}
                </span>
              ) : null}
              <span className="sr-only">{step.title || ''}</span>
            </>
          ) : (
            step.title || ''
          )}
        </span>
        {stepStatusBadge(step.status)}
      </summary>
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
    </details>
  )
}
