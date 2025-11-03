import React, { useMemo } from 'react'
import { match } from 'ts-pattern'
import type { Turn } from '../stores/chat-turns'
import { useChatTurnStore } from '../stores/chat-turns'
import { STAGING_CID } from '../stores/chat-turns-core'
import { Copy, RotateCcw, Check } from 'lucide-react'
// step 图标与状态徽标移动至 cards/common
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { stripDuplicatedTitle } from '@/features/codex-chat/stores/chat-turns-utils'
import { StepIcon, stepStatusBadge } from './cards/common'
import { ExecStepCard } from './cards/exec-step-card'
import { McpStepCard } from './cards/mcp-step-card'
import { ReadStepCard } from './cards/read-step-card'
import { ListStepCard } from './cards/list-step-card'
import { SearchStepCard } from './cards/search-step-card'
import { PatchStepCard } from './cards/patch-step-card'
import { GenericStepCard } from './cards/generic-step-card'
import { InfoCompactCard } from './cards/info-compact-card'
import { PlanStepCard } from './cards/plan-step-card'
import { ChatMessage } from '@/components/ui/chat-message'
import { TypingIndicator } from '@/components/ui/typing-indicator'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'

function hasRenderableAssistantText(input: string): boolean {
  if (typeof input !== 'string') return false
  const trimmed = input.trim()
  if (!trimmed) return false
  // 去掉常见 Markdown 标记后再确认是否仍有可见字符
  const stripped = trimmed.replace(/[\s`*_~>#\-]/g, '')
  return stripped.length > 0
}

function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first
      .replace(/^[\s#>*_`]+/, '')
      .replace(/[\s#*_`]+$/, '')
      .trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

// 详情与样式分布见各 cards/* 组件

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
  const norm = (s: string) =>
    s
      .replace(/^[\s#>*_`]+/, '')
      .replace(/[\s#*_`]+$/, '')
      .trim()
  if (norm(lines[firstIdx]) !== norm(title)) return raw
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === firstIdx) continue
    if (i === firstIdx + 1) {
      let j = i
      // 仅当存在需要跳过的空行时才回退索引，避免死循环
      while (j < lines.length && lines[j].trim().length === 0) j++
      if (j !== i) {
        i = j - 1
        continue
      }
    }
    out.push(lines[i])
  }
  return out.join('\n')
}

export function TurnUserView({ turn }: { turn: Turn }) {
  const text = turn.user?.text ?? ''
  if (!text.trim()) return null
  const conv = turn.conversationId || 'local'
  const msgId = `${conv}:${turn.seq}:u`
  return (
    <div className="flex items-start gap-2 py-1.5 justify-end">
      <div className="w-full flex justify-end">
        <ChatMessage id={msgId} role="user" content={text} />
      </div>
      <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs bg-muted">
        你
      </div>
    </div>
  )
}

export function TurnAssistantView({
  turn,
  onRetry,
  disableRetry
}: {
  turn: Turn
  onRetry?: (text: string) => void
  disableRetry?: boolean
}) {
  const latestTurnSelector = useMemo(() => {
    return (state: any) => {
      const locator = state.turnLocator?.[turn.id]
      if (!locator) return false
      const slice = state.byConv?.[locator.conversationId]
      if (!slice) return false
      const idx = slice.turnIndex?.[turn.id]
      if (typeof idx !== 'number') return false
      const turns = Array.isArray(slice.turns) ? slice.turns : []
      return turns.length > 0 && idx === turns.length - 1
    }
  }, [turn.id])
  const isLatestTurn = useChatTurnStore(latestTurnSelector)
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
  const { working, workingTitle, detailsCount } = useChatTurnStore((s) =>
    s.deriveWorkingState(turn.id)
  )
  const generatingSelector = useMemo(() => {
    return (state: any) => {
      const key = typeof turn.conversationId === 'string' ? turn.conversationId : STAGING_CID
      const slice = state.byConv?.[key] ?? state.byConv?.[STAGING_CID]
      return !!slice?.generating
    }
  }, [turn.conversationId])
  const isConversationGenerating = useChatTurnStore(generatingSelector)
  // resume 构建的 turn（history/events）保持原来的“thinking 折叠块”行为；
  // 实时 turn 在仅有 reasoning 时也显示 Working 折叠区以统一体验。
  const isResumeLike = useMemo(() => {
    const id = String(turn.id || '')
    return id.startsWith('turn-history_') || id.startsWith('turn-events_')
  }, [turn.id])
  const showLoadingOnly = useMemo(() => {
    const noSteps = (turn.steps || []).length === 0
    const noAssistant = !(
      typeof turn.assistant?.text === 'string' && turn.assistant.text.trim().length > 0
    )
    return !isResumeLike && working && noSteps && !hasReasoning && noAssistant
  }, [isResumeLike, working, turn.steps, hasReasoning, turn.assistant])

  const showWorkingHeader = useMemo(() => {
    // 仅当有可展开内容（steps 或 reasoning）时显示 Working 折叠区；
    // 避免“Working 标题 + 三点气泡”重复展示
    if ((turn.steps || []).length > 0) return true
    if (!isResumeLike && hasReasoning) return true
    return false
  }, [turn.steps, isResumeLike, hasReasoning])
  const headerCount = useMemo(() => {
    const base = (turn.steps || []).length
    const includePreview = !isResumeLike && hasReasoning && !hasThinkingStep
    return base + (includePreview ? 1 : 0)
  }, [turn.steps, isResumeLike, hasReasoning, hasThinkingStep])

  const steps = turn.steps || []
  const assistantText = turn.assistant?.text ?? ''
  const userText = turn.user?.text ?? ''
  const assistantHasRenderableText = useMemo(
    () => hasRenderableAssistantText(assistantText),
    [assistantText]
  )

  const { isCopied, handleCopy } = useCopyToClipboard({
    text: assistantText,
    copyMessage: '已复制回复'
  })
  const copyDisabled = assistantText.trim().length === 0
  const retryDisabled = Boolean(disableRetry) || userText.trim().length === 0

  const actions = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          if (copyDisabled) return
          handleCopy()
        }}
        disabled={copyDisabled}
        title={isCopied ? '已复制' : '复制'}
        aria-label={isCopied ? '已复制' : '复制'}
        className={cn(
          'flex size-7 items-center justify-center rounded-md border border-transparent bg-background text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          copyDisabled && 'cursor-not-allowed opacity-50'
        )}
      >
        {isCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
      {onRetry ? (
        <button
          type="button"
          onClick={() => {
            if (retryDisabled) return
            onRetry(userText)
          }}
          disabled={retryDisabled}
          title="重试"
          aria-label="重试"
          className={cn(
            'flex size-7 items-center justify-center rounded-md border border-transparent bg-background text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            retryDisabled && 'cursor-not-allowed opacity-50'
          )}
        >
          <RotateCcw className="size-4" />
        </button>
      ) : null}
    </div>
  )

  return (
    <div className="flex items-start gap-2 py-1.5">
      <div className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-xs bg-muted">
        AI
      </div>
      <div className="w-full">
        {showWorkingHeader ? (
          <Collapsible
            key={`${turn.id}-${turn.status}-${working ? 'w' : 'nw'}-${isLatestTurn ? 'last' : 'prev'}`}
            defaultOpen={working && isLatestTurn}
          >
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
                {!isResumeLike && hasReasoning && !hasThinkingStep && steps.length === 0 ? (
                  <details className="border-b border-border pb-1">
                    <summary className="flex items-center gap-2 truncate text-sm">
                      <StepIcon kind={'thinking'} />
                      <span className="truncate">
                        {reasoningTitle ? `thinking: ${reasoningTitle}` : 'thinking'}
                      </span>
                    </summary>
                    {reasoningBody ? (
                      <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-xs">
                        {reasoningBody}
                      </pre>
                    ) : null}
                  </details>
                ) : null}
                {/* 实时：刚开始工作但尚未收到任何有效 WS 事件（无步骤、无 reasoning、无助手正文）时，显示三点占位 */}
                {showLoadingOnly ? <TypingIndicator /> : null}
                {steps.map((step) => {
                  const isCompactInfo = step.kind === 'info' && (step as any)?.meta?.compactDone
                  if (isCompactInfo) return <InfoCompactCard key={step.id} step={step} />
                  return match(step.kind)
                    .with('exec', () => <ExecStepCard key={step.id} step={step} />)
                    .with('mcp', () => <McpStepCard key={step.id} step={step} />)
                    .with('read', () => <ReadStepCard key={step.id} step={step} turn={turn} />)
                    .with('list', () => <ListStepCard key={step.id} step={step} turn={turn} />)
                    .with('search', () => <SearchStepCard key={step.id} step={step} turn={turn} />)
                    .with('patch', () => <PatchStepCard key={step.id} step={step} />)
                    .with('plan', () => <PlanStepCard key={step.id} step={step} />)
                    .otherwise(() => <GenericStepCard key={step.id} step={step} />)
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {hasReasoning && !hasThinkingStep && (!showWorkingHeader || isResumeLike) ? (
          <Collapsible>
            <CollapsibleTrigger className="mt-1 flex items-center gap-2 text-xs text-primary hover:underline">
              <span className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                thinking
              </span>
              <span className="truncate">{reasoningTitle || 'Thinking'}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {reasoningBody ? (
                <pre className="mt-1 whitespace-pre-wrap wrap-break-word text-sm">
                  {reasoningBody}
                </pre>
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        ) : null}

        {/* 当仅 Loading 且不显示 Working 抬头时，在正文位置显示三点占位 */}
        {!showWorkingHeader && showLoadingOnly ? <TypingIndicator /> : null}

        {!showWorkingHeader &&
        !showLoadingOnly &&
        turn.status === 'streaming' &&
        isConversationGenerating &&
        !assistantHasRenderableText ? (
          <TypingIndicator />
        ) : null}

        {typeof turn.assistant?.text === 'string' && turn.assistant.text.trim().length > 0 ? (
          <ChatMessage
            id={`${turn.conversationId || 'local'}:${turn.seq}:a`}
            role="assistant"
            content={turn.assistant.text}
            actions={actions}
          />
        ) : // 兜底：当刷新 resume 后最后一轮仅有 user 且处于 streaming、没有步骤和助手文本时，展示 TypingIndicator 占位
        // 纯渲染层，不入环、不写入 steps，避免影响 SSoT 与幂等
        isResumeLike && turn.status === 'streaming' && steps.length === 0 ? (
          <TypingIndicator />
        ) : null}
      </div>
    </div>
  )
}
