import React, { useMemo } from 'react'
import { match } from 'ts-pattern'
import type { Turn, TurnStep } from '../stores/chat-turns'
import { useChatTurnStore } from '../stores/chat-turns'
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
import { stripDuplicatedTitle } from '@/features/codex-chat/stores/chat-turns-utils'

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
  return match(kind)
    .with('exec', () => <TerminalIcon className={cls} />)
    .with('patch', () => <FileDiffIcon className={cls} />)
    .with('mcp', () => <PlugIcon className={cls} />)
    .with('search', () => <SearchIcon className={cls} />)
    .with('list', () => <ListIcon className={cls} />)
    .with('read', () => <FileTextIcon className={cls} />)
    .with('thinking', () => <BrainIcon className={cls} />)
    .with('plan', () => <ListIcon className={cls} />)
    .otherwise(() => <InfoIcon className={cls} />)
}

function buildExecTitle(step: TurnStep): string {
  const raw = Array.isArray(step.meta?.command)
    ? (step.meta?.command as string[]).join('\n')
    : String(step.title || '')
  const isPatch = /apply_patch|applypatch|git\s+apply/i.test(raw) || /\*\*\*\s+Begin Patch/.test(raw)
  if (isPatch) {
    try {
      const m = raw.match(/\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)/)
      const headPath = m ? m[1].trim() : ''
      const name = headPath ? headPath.replace(/\/+$/g, '').split('/').pop() || headPath : ''
      return name ? `patch ${name}` : 'patch (apply_patch)'
    } catch {
      return 'patch (apply_patch)'
    }
  }
  const first = raw.replace(/\r/g, '').split(/\n/)[0] || ''
  const compact = first.length > 120 ? `${first.slice(0, 120)}…` : first
  return compact || 'exec'
}

function renderReadLikeIO(step: TurnStep, turn: Turn) {
  const args = (() => {
    const cmd = Array.isArray(step.meta?.command) ? step.meta.command.join(' ') : ''
    const cwd = typeof step.meta?.cwd === 'string' ? step.meta.cwd : ''
    return [cmd || '', cwd ? `(cwd=${cwd})` : ''].filter(Boolean).join('\n') || '(empty)'
  })()
  const out = (() => {
    const body = String(step.body || '').trim()
    const stdout = typeof step.meta?.stdout === 'string' ? step.meta.stdout : ''
    const stderr = typeof step.meta?.stderr === 'string' ? step.meta.stderr : ''
    let merged = body || [stdout, stderr].filter(Boolean).join('\n')
    if (!merged) {
      try {
        const cmdKey = JSON.stringify(step.meta?.command || [])
        const cwdKey = String(step.meta?.cwd || '')
        const peer = (turn.steps || []).find((s) => {
          if (s.id === step.id) return false
          const k1 = JSON.stringify((s as any)?.meta?.command || [])
          const k2 = String((s as any)?.meta?.cwd || '')
          return k1 === cmdKey && k2 === cwdKey
        }) as any
        if (peer) {
          const pout = String(peer.body || '').trim()
          const pstdout = typeof peer.meta?.stdout === 'string' ? peer.meta.stdout : ''
          const pstderr = typeof peer.meta?.stderr === 'string' ? peer.meta.stderr : ''
          merged = pout || [pstdout, pstderr].filter(Boolean).join('\n')
        }
      } catch {}
    }
    return merged
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

function renderExecIO(step: TurnStep) {
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

function renderMcpIO(step: TurnStep) {
  const argsText = (() => {
    const args = (step.meta?.args as any)
    try {
      if (typeof args === 'string') return args
      if (args == null) return '(empty)'
      return JSON.stringify(args, null, 2)
    } catch {
      return String(args ?? '(empty)')
    }
  })()
  const resNode = (() => {
    const res = (step.meta?.result as any)
    try {
      if (typeof res === 'string') {
        const trimmed = res.trim()
        return trimmed ? (
          <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{trimmed}</pre>
        ) : (
          <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
        )
      }
      if (res == null) return <div className="mt-0.5 text-xs text-muted-foreground">(no output)</div>
      return (
        <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{JSON.stringify(res, null, 2)}</pre>
      )
    } catch {
      return <pre className="mt-0.5 whitespace-pre-wrap wrap-break-word text-xs">{String(res ?? '')}</pre>
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
        <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">{text}</pre>
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
  const { working, workingTitle, detailsCount } = useChatTurnStore(s => s.deriveWorkingState(turn.id))
  // resume 构建的 turn（history/events）保持原来的“thinking 折叠块”行为；
  // 实时 turn 在仅有 reasoning 时也显示 Working 折叠区以统一体验。
  const isResumeLike = useMemo(() => {
    const id = String(turn.id || '')
    return id.startsWith('turn-history_') || id.startsWith('turn-events_')
  }, [turn.id])
  const showWorkingHeader = useMemo(() => {
    if ((turn.steps || []).length > 0) return true
    if (!isResumeLike && (working || hasReasoning)) return true
    return false
  }, [turn.steps, isResumeLike, working, hasReasoning])
  const headerCount = useMemo(() => {
    const base = (turn.steps || []).length
    const includePreview = !isResumeLike && hasReasoning && !hasThinkingStep
    return base + (includePreview ? 1 : 0)
  }, [turn.steps, isResumeLike, hasReasoning, hasThinkingStep])

  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs bg-muted">AI</div>
      <div className="flex-1 min-w-0">
        {showWorkingHeader ? (
          <Collapsible key={`${turn.id}-${turn.status}-${working ? 'w' : 'nw'}`} defaultOpen={working}>
            <CollapsibleTrigger className="mt-1 text-xs text-primary hover:underline">
              {(() => {
                const cnt = (headerCount || 0) > 0 ? headerCount : detailsCount
                return (
                  <>
                    {workingTitle || 'Working'}
                    {cnt > 0 ? <>（{cnt} 条）</> : null}
                  </>
                )
              })()}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 space-y-1">
                {/* 实时：当仅有 reasoning 且尚无步骤时，临时把推理放到 Working 折叠区内部展示 */}
                {(!isResumeLike && hasReasoning && !hasThinkingStep && (turn.steps || []).length === 0) ? (
                  <details className="border-b border-border pb-1">
                    <summary className="flex items-center gap-2 truncate text-sm">
                      <StepIcon kind={'thinking'} />
                      <span className="truncate">{reasoningTitle ? `thinking: ${reasoningTitle}` : 'thinking'}</span>
                      {stepStatusBadge('streaming')}
                    </summary>
                    {reasoningBody ? (
                      <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">{reasoningBody}</pre>
                    ) : null}
                  </details>
                ) : null}
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
                          {match(step.kind)
                            .with('mcp', () => {
                              const server = String((step.meta?.server ?? '') || '')
                              const tool = String((step.meta?.tool ?? '') || '')
                              return server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : step.title || 'mcp'
                            })
                            .with('exec', () => buildExecTitle(step))
                            .otherwise(() => step.title || '')}
                        </span>
                        {step.kind === 'patch' && Array.isArray(step.tags) && step.tags.length > 0 ? (
                          <span className="ml-4 inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                            {step.tags[0]}
                          </span>
                        ) : null}
                        {stepStatusBadge(step.status)}
                      </summary>
                      {step.kind !== 'patch' && Array.isArray(step.tags) && step.tags.length > 0 ? (
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

                      {/* 详情区：按步骤类型匹配渲染 */}
                      {match(step.kind)
                        .with('exec', () => renderExecIO(step))
                        .with('read', () => renderReadLikeIO(step, turn))
                        .with('list', () => renderReadLikeIO(step, turn))
                        .with('search', () => renderReadLikeIO(step, turn))
                        .with('mcp', () => renderMcpIO(step))
                        .with('patch', () => {
                          const diff = String(step.body || '').trim()
                          return (
                            <div className="mt-1 max-h-[200px] overflow-auto pr-1">
                              {diff ? (
                                <pre className="whitespace-pre-wrap wrap-break-word text-xs">{diff}</pre>
                              ) : (
                                <div className="text-xs text-muted-foreground">(no diff)</div>
                              )}
                            </div>
                          )
                        })
                        .otherwise(() => {
                          const raw = String(step.body || '')
                          if (!raw.trim()) return null
                          if (step.kind !== 'thinking') {
                            return <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">{raw}</pre>
                          }
                          const titleOnly = String(step.title || '').replace(/^thinking:\s*/i, '').trim()
                          const cleaned = titleOnly ? stripDuplicatedTitle(raw, titleOnly) : raw
                          return <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">{cleaned}</pre>
                        })}
                    </details>
                  )
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {(hasReasoning && !hasThinkingStep && (!showWorkingHeader || isResumeLike)) ? (
          <Collapsible>
            <CollapsibleTrigger className="mt-1 flex items-center gap-2 text-xs text-primary hover:underline">
              <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                thinking
              </span>
              <span className="truncate">{reasoningTitle || 'Thinking'}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {reasoningBody ? (
                <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">{reasoningBody}</pre>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {typeof turn.assistant?.text === 'string' && turn.assistant.text.trim().length > 0 ? (
          <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">{turn.assistant.text}</pre>
        ) : null}
      </div>
    </div>
  )
}
