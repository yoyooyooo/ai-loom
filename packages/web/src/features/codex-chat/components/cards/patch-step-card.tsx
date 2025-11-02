import React from 'react'
import { StepIcon, StepCardProps, stepStatusBadge } from './common'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AlertTriangle as AlertTriangleIcon } from 'lucide-react'

function derivePatchCounts(step: any) {
  const mpatch = step?.meta?.patch
  const pAdd = typeof mpatch?.adds === 'number' ? mpatch.adds : undefined
  const pDel = typeof mpatch?.dels === 'number' ? mpatch.dels : undefined
  if (typeof pAdd === 'number' && typeof pDel === 'number') return { add: pAdd, del: pDel }
  const addMeta = typeof step?.meta?.adds === 'number' ? step.meta.adds : undefined
  const delMeta = typeof step?.meta?.dels === 'number' ? step.meta.dels : undefined
  if (typeof addMeta === 'number' && typeof delMeta === 'number')
    return { add: addMeta, del: delMeta }
  const raw = Array.isArray(step?.tags) && step.tags.length > 0 ? String(step.tags[0]) : ''
  const m = raw.match(/^\s*([+-]?\d+)\s*$/)
  if (m) {
    const n = Number(m[1])
    if (!Number.isNaN(n)) return n >= 0 ? { add: n, del: 0 } : { add: 0, del: Math.abs(n) }
  }
  return { raw }
}

export function PatchStepCard({ step }: StepCardProps) {
  const diff = String(step.body || '').trim()
  const { add, del, raw } = derivePatchCounts(step)
  const firstPath: string | undefined = (step as any)?.meta?.patch?.firstPath
  const files: number | undefined = (step as any)?.meta?.patch?.files
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
  const name = lastName(firstPath)
  const extra = name && typeof files === 'number' && files > 1 ? ` (+${files - 1})` : ''

  // 统一以通用状态判定失败：后端在 patch.end 已将失败写为 status='failed'
  const failure = step.status === 'failed'
  const pickFirstLine = (s?: unknown) => {
    try {
      const raw = String(s || '').replace(/\r/g, '')
      const first = raw.split(/\n/).find((ln) => ln.trim().length > 0)
      return (first || '').trim()
    } catch {
      return ''
    }
  }
  const failureReason = failure
    ? pickFirstLine(step?.meta?.stderr) || pickFirstLine(step?.meta?.stdout) || 'Patch failed'
    : ''

  return (
    <details className="border-b border-border pb-1">
      <summary className="flex items-center gap-2 truncate text-sm">
        <StepIcon kind={step.kind} />
        <span className="truncate">
          {name ? (
            <>
              {'patch '}
              <span className="text-primary font-bold">{name}</span>
              {extra ? <span> {extra}</span> : null}
              <span className="sr-only">{step.title || ''}</span>
            </>
          ) : (
            step.title || ''
          )}
        </span>
        {failure ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <AlertTriangleIcon className="size-3.5 shrink-0 text-destructive" />
            </TooltipTrigger>
            <TooltipContent side="top">{failureReason}</TooltipContent>
          </Tooltip>
        ) : null}
        {typeof add === 'number' && typeof del === 'number' ? (
          <>
            <span className="ml-4 inline-flex items-center rounded px-1 py-0.5 text-xs text-emerald-600 bg-emerald-50">
              +{add}
            </span>
            <span className="inline-flex items-center rounded px-1 py-0.5 text-xs text-destructive bg-red-50">
              -{del}
            </span>
          </>
        ) : raw ? (
          <span className="ml-4 inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
            {raw}
          </span>
        ) : null}
        {stepStatusBadge(step.status)}
      </summary>
      <div className="mt-1 max-h-[200px] overflow-auto pr-1">
        {diff ? (
          <pre className="whitespace-pre-wrap wrap-break-word text-xs">{diff}</pre>
        ) : (
          <div className="text-xs text-muted-foreground">(no diff)</div>
        )}
      </div>
    </details>
  )
}
