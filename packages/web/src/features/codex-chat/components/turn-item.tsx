import React, { useMemo } from 'react'
import type { Turn, TurnStep } from '../stores/chat-turns'
import {
  Terminal as TerminalIcon,
  FileDiff as FileDiffIcon,
  Plug as PlugIcon,
  Search as SearchIcon,
  List as ListIcon,
  FileText as FileTextIcon,
  Info as InfoIcon,
  Brain as BrainIcon
} from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first.replace(/^[\s#>*_`]+/, '').replace(/[\s#*_`]+$/, '').trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

// 已取消顶部状态徽标，Working/Finished/Failed/Aborted 状态通过可展开区标题表达

function stepStatusBadge(status: TurnStep['status']) {
  if (status === 'streaming') return <span className="text-xs text-muted-foreground">[streaming]</span>
  if (status === 'failed') return <span className="text-xs text-destructive">[failed]</span>
  if (status === 'aborted') return <span className="text-xs text-muted-foreground">[aborted]</span>
  return null
}

function StepIcon({ kind }: { kind: TurnStep['kind'] }) {
  const cls = 'size-3.5 shrink-0 text-muted-foreground'
  switch (kind) {
    case 'exec':
      return <TerminalIcon className={cls} />
    case 'patch':
      return <FileDiffIcon className={cls} />
    case 'mcp':
      return <PlugIcon className={cls} />
    case 'search':
      return <SearchIcon className={cls} />
    case 'list':
      return <ListIcon className={cls} />
    case 'read':
      return <FileTextIcon className={cls} />
    case 'thinking':
      return <BrainIcon className={cls} />
    case 'plan':
      return <ListIcon className={cls} />
    case 'info':
    default:
      return <InfoIcon className={cls} />
  }
}

function normalizeReasoningBody(content: string, title?: string) {
  const raw = String(content || '')
  if (!raw.trim()) return ''
  if (!title) return raw
  const lines = raw.replace(/\r/g, '').split(/\n/)
  let firstIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      firstIdx = i
      break
    }
  }
  if (firstIdx < 0) return raw
  const norm = (s: string) => s.replace(/^[\s#>*_`]+/, '').replace(/[\s#*_`]+$/, '').trim()
  if (norm(lines[firstIdx]) !== norm(title)) return raw
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === firstIdx) continue
    if (i === firstIdx + 1) {
      let j = i
      while (j < lines.length && lines[j].trim().length === 0) j++
      i = j - 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

export function TurnUserView({ turn }: { turn: Turn }) {
  const text = turn.user?.text ?? ''
  if (!text.trim()) return null
  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs bg-muted">你</div>
      <div className="flex-1 min-w-0">
        <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{text}</pre>
      </div>
    </div>
  )
}

export function TurnAssistantView({ turn }: { turn: Turn }) {
  const reasoningTitle = useMemo(() => {
    if (!turn.reasoning || !turn.reasoning.content) return ''
    return turn.reasoning.title || summarizeFirstLine(turn.reasoning.content)
  }, [turn.reasoning])

  const reasoningBody = useMemo(() => {
    if (!turn.reasoning || !turn.reasoning.content) return ''
    return normalizeReasoningBody(turn.reasoning.content, reasoningTitle)
  }, [turn.reasoning, reasoningTitle])

  const hasReasoning = Boolean((turn.reasoning?.content || '').trim())
  const hasThinkingStep = useMemo(() => turn.steps.some((s) => s.kind === 'thinking'), [turn.steps])
  const workingTitle = turn.meta?.workingTitle
    || (turn.steps.some((step) => step.status === 'streaming') ? 'Working' : 'Finished working')
  const detailsCount = turn.steps.length

  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs bg-muted">AI</div>
      <div className="flex-1 min-w-0">
        {turn.steps.length > 0 ? (
          <Collapsible key={`${turn.id}-${turn.status}-${turn.meta?.working ? 'w' : 'nw'}`} defaultOpen={turn.status === 'streaming' || !!turn.meta?.working}>
            <CollapsibleTrigger className="mt-1 text-xs text-primary hover:underline">
              {workingTitle || 'Working'}（{detailsCount} 条）
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1">
                {turn.steps.map((step) => {
                  const isCompactInfo = step.kind === 'info' && (step as any)?.meta?.compactDone
                  if (isCompactInfo) {
                    return (
                      <div key={step.id} className="border-b border-border pb-1">
                        <div className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
                          <StepIcon kind={step.kind} />
                          <span className="truncate">{step.title}</span>
                        </div>
                      </div>
                    )
                  }
                  return (
                    <details key={step.id} className="border-b border-border pb-1">
                      <summary className="flex items-center gap-2 truncate text-sm">
                        <StepIcon kind={step.kind} />
                        {/* 封面标题：mcp 用 server/tool，exec 用命令，其他用原始标题 */}
                        <span className="truncate">
                          {step.kind === 'mcp'
                            ? (() => {
                                const server = String((step.meta?.server ?? '') || '')
                                const tool = String((step.meta?.tool ?? '') || '')
                                return server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : (step.title || 'mcp')
                              })()
                            : step.kind === 'exec'
                            ? (() => {
                                const cmd = Array.isArray(step.meta?.command) ? step.meta.command.join(' ') : (step.title || 'exec')
                                return cmd || 'exec'
                              })()
                            : (step.title || '')}
                        </span>
                        {stepStatusBadge(step.status)}
                      </summary>
                      {Array.isArray(step.tags) && step.tags.length > 0 ? (
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
                      ) : null}

                      {/* 详情两栏：上=入参，下=执行输出（exec/mcp/patch）；其余保留原 body 展示 */}
                      {step.kind === 'exec' ? (
                        <div className="mt-1 space-y-1 max-h-[200px] overflow-auto pr-1">
                          <div>
                            <div className="text-xs text-muted-foreground">入参</div>
                            <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                              {(() => {
                                const cmd = Array.isArray(step.meta?.command) ? step.meta.command.join(' ') : ''
                                const cwd = typeof step.meta?.cwd === 'string' ? step.meta.cwd : ''
                                return [cmd || '', cwd ? `(cwd=${cwd})` : ''].filter(Boolean).join('\n') || '(empty)'
                              })()}
                            </pre>
                          </div>
                          <div className="my-1 border-t border-border" />
                          <div>
                            <div className="text-xs text-muted-foreground">输出</div>
                            {(() => {
                              const out = String(step.body || '').trim()
                              const stdout = typeof step.meta?.stdout === 'string' ? step.meta.stdout : ''
                              const stderr = typeof step.meta?.stderr === 'string' ? step.meta.stderr : ''
                              const merged = out || [stdout, stderr].filter(Boolean).join('\n')
                              return merged ? (
                                <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">{merged}</pre>
                              ) : (
                                <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
                              )
                            })()}
                          </div>
                        </div>
                      ) : step.kind === 'mcp' ? (
                        <div className="mt-1 space-y-1 max-h-[200px] overflow-auto pr-1">
                          <div>
                            <div className="text-xs text-muted-foreground">入参</div>
                            <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                              {(() => {
                                const args = (step.meta?.args as any)
                                try {
                                  if (typeof args === 'string') return args
                                  if (args == null) return '(empty)'
                                  return JSON.stringify(args, null, 2)
                                } catch {
                                  return String(args ?? '(empty)')
                                }
                              })()}
                            </pre>
                          </div>
                          <div className="my-1 border-t border-border" />
                          <div>
                            <div className="text-xs text-muted-foreground">输出</div>
                            {(() => {
                              const res = (step.meta?.result as any)
                              try {
                                if (typeof res === 'string') {
                                  const trimmed = res.trim()
                                  return trimmed ? (
                                    <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">{trimmed}</pre>
                                  ) : (
                                    <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
                                  )
                                }
                                if (res == null) return <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
                                return (
                                  <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">{JSON.stringify(res, null, 2)}</pre>
                                )
                              } catch {
                                return <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">{String(res ?? '')}</pre>
                              }
                            })()}
                          </div>
                        </div>
                      ) : step.kind === 'patch' ? (
                        <div className="mt-1 space-y-1 max-h-[200px] overflow-auto pr-1">
                          <div>
                            <div className="text-xs text-muted-foreground">入参</div>
                            <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                              {(() => {
                                const files = typeof step.meta?.files === 'number' ? step.meta.files : undefined
                                const first = typeof step.meta?.firstPath === 'string' ? step.meta.firstPath : ''
                                const adds = typeof step.meta?.adds === 'number' ? step.meta.adds : undefined
                                const dels = typeof step.meta?.dels === 'number' ? step.meta.dels : undefined
                                const auto = step.meta?.autoApproved ? 'auto' : 'manual'
                                const lines = [] as string[]
                                if (files != null) lines.push(`files: ${files}`)
                                if (first) lines.push(`first: ${first}`)
                                if (adds != null || dels != null) lines.push(`diff: ${adds != null ? `+${adds}` : ''}${dels != null ? ` -${dels}` : ''}`.trim())
                                lines.push(`approval: ${auto}`)
                                return lines.join('\n') || '(empty)'
                              })()}
                            </pre>
                          </div>
                          <div className="my-1 border-t border-border" />
                          <div>
                            <div className="text-xs text-muted-foreground">输出</div>
                            {(() => {
                              const stdout = typeof step.meta?.stdout === 'string' ? step.meta.stdout : ''
                              const stderr = typeof step.meta?.stderr === 'string' ? step.meta.stderr : ''
                              const combined = [stdout, stderr].filter(Boolean).join('\n')
                              return combined ? (
                                <pre className="mt-0.5 whitespace-pre-wrap break-words text-xs">{combined}</pre>
                              ) : (
                                <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
                              )
                            })()}
                          </div>
                        </div>
                      ) : step.body && step.body.trim().length > 0 ? (
                        <pre className="mt-1 whitespace-pre-wrap break-words text-xs">{step.body}</pre>
                      ) : null}
                    </details>
                  )
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {hasReasoning && !hasThinkingStep ? (
          <Collapsible>
            <CollapsibleTrigger className="mt-1 flex items-center gap-2 text-xs text-primary hover:underline">
              <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                thinking
              </span>
              <span className="truncate">{reasoningTitle || 'Thinking'}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {reasoningBody ? (
                <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{reasoningBody}</pre>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {typeof turn.assistant?.text === 'string' && turn.assistant.text.trim().length > 0 ? (
          <pre className="mt-1 whitespace-pre-wrap break-words text-sm">{turn.assistant.text}</pre>
        ) : null}
      </div>
    </div>
  )
}
