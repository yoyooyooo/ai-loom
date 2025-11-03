import React from 'react'
import { match } from 'ts-pattern'
import type { Turn, TurnStep } from '../../stores/chat-turns'
import { Loader2 } from 'lucide-react'
import {
  Terminal as TerminalIcon,
  FileDiff as FileDiffIcon,
  Plug as PlugIcon,
  Search as SearchIcon,
  List as ListIcon,
  FileText as FileTextIcon,
  Info as InfoIcon,
  Brain as BrainIcon,
  ArrowRightLeft as ArrowRightLeftIcon
} from 'lucide-react'

export type StepCardProps = {
  step: TurnStep
  turn?: Turn
}

// 已取消顶部状态徽标，Working/Finished/Failed/Aborted 状态通过可展开区标题表达
export function stepStatusBadge(
  status: TurnStep['status'],
  options?: { hideStreaming?: boolean }
) {
  if (status === 'streaming') {
    if (options?.hideStreaming) return null
    return <Loader2 className="size-3.5 text-muted-foreground animate-spin" />
  }
  if (status === 'failed') return <span className="text-xs text-destructive">[failed]</span>
  if (status === 'aborted') return <span className="text-xs text-muted-foreground">[aborted]</span>
  return null
}

function detectPrimaryExecCommand(step?: TurnStep): string | undefined {
  if (!step || !Array.isArray(step.meta?.command)) return undefined
  const command = (step.meta.command as string[]).map((part) => String(part))
  if (command.length === 0) return undefined
  const head = command[0]
  const flag = command[1] || ''
  const isShellWrapper = /(?:^|\/)(?:ba?sh|zsh|sh)$/.test(head) && (flag === '-lc' || flag === '-c')
  if (isShellWrapper && command.length >= 3) {
    const script = command.slice(2).join(' ').trim()
    if (script) {
      const firstLine = script.split(/\r?\n/)[0] || ''
      const firstToken = firstLine.trim().split(/\s+/)[0] || ''
      if (firstToken) return normalizeCommandName(firstToken)
    }
    return normalizeCommandName(head)
  }
  return normalizeCommandName(head)
}

function normalizeCommandName(raw: string): string {
  const stripped = raw.replace(/^['"]+/, '').replace(/['"]+$/, '')
  if (!stripped) return stripped
  const last = stripped.split('/').filter(Boolean).pop()
  return (last || stripped).toLowerCase()
}

export function StepIcon({ kind, step }: { kind: TurnStep['kind']; step?: TurnStep }) {
  const cls = 'size-3.5 shrink-0 text-muted-foreground'
  return match(kind)
    .with('exec', () => {
      const primary = detectPrimaryExecCommand(step)
      if (primary === 'mv') return <ArrowRightLeftIcon className={cls} />
      return <TerminalIcon className={cls} />
    })
    .with('patch', () => <FileDiffIcon className={cls} />)
    .with('mcp', () => <PlugIcon className={cls} />)
    .with('search', () => <SearchIcon className={cls} />)
    .with('list', () => <ListIcon className={cls} />)
    .with('read', () => <FileTextIcon className={cls} />)
    .with('thinking', () => <BrainIcon className={cls} />)
    .with('plan', () => <ListIcon className={cls} />)
    .otherwise(() => <InfoIcon className={cls} />)
}

export function TagsRow({ step }: { step: TurnStep }) {
  if (step.kind === 'patch') return null
  if (!Array.isArray(step.tags) || step.tags.length === 0) return null
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {step.tags.map((tag, i) => (
        <span
          key={`${step.id}-tag-${i}`}
          className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  )
}
