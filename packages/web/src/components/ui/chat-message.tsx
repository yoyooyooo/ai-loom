'use client'

import React, { useMemo, useState } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { motion } from 'framer-motion'
import { Ban, ChevronRight, Code2, Loader2, TextSelect, Terminal } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { FilePreview } from '@/components/ui/file-preview'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const chatBubbleVariants = cva(
  'group/message relative wrap-break-word rounded-lg p-3 text-sm shrink-0',
  {
    variants: {
      isUser: {
        // 浅色下沿用主题主色；深色下按需调整为 #303030，文字白色
        true: 'bg-primary text-primary-foreground dark:bg-[#303030] dark:text-white max-w-[80%] ',
        false: 'bg-muted text-foreground max-w-[calc(100%-50px)]'
      },
      animation: {
        none: '',
        slide: 'duration-300 animate-in fade-in-0',
        scale: 'duration-300 animate-in fade-in-0 zoom-in-75',
        fade: 'duration-500 animate-in fade-in-0'
      }
    },
    compoundVariants: [
      {
        isUser: true,
        animation: 'slide',
        class: 'slide-in-from-right'
      },
      {
        isUser: false,
        animation: 'slide',
        class: 'slide-in-from-left'
      },
      {
        isUser: true,
        animation: 'scale',
        class: 'origin-bottom-right'
      },
      {
        isUser: false,
        animation: 'scale',
        class: 'origin-bottom-left'
      }
    ]
  }
)

type Animation = VariantProps<typeof chatBubbleVariants>['animation']

interface Attachment {
  name?: string
  contentType?: string
  url: string
}

interface PartialToolCall {
  state: 'partial-call'
  toolName: string
}

interface ToolCall {
  state: 'call'
  toolName: string
}

interface ToolResult {
  state: 'result'
  toolName: string
  result: {
    __cancelled?: boolean
    [key: string]: any
  }
}

type ToolInvocation = PartialToolCall | ToolCall | ToolResult

interface ReasoningPart {
  type: 'reasoning'
  reasoning: string
}

interface ToolInvocationPart {
  type: 'tool-invocation'
  toolInvocation: ToolInvocation
}

interface TextPart {
  type: 'text'
  text: string
}

// For compatibility with AI SDK types, not used
interface SourcePart {
  type: 'source'
  source?: any
}

interface FilePart {
  type: 'file'
  mimeType: string
  data: string
}

interface StepStartPart {
  type: 'step-start'
}

type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolInvocationPart
  | SourcePart
  | FilePart
  | StepStartPart

const IDE_CONTEXT_HEADER = '# Context from my IDE setup:'
const IDE_REQUEST_HEADER = '## My request for Codex:'

function splitIdeInjectedContext(raw: string) {
  const input = typeof raw === 'string' ? raw : ''
  if (!input) return { request: input, context: '' }
  if (!input.startsWith(IDE_CONTEXT_HEADER)) {
    return { request: input, context: '' }
  }
  const normalized = input.replace(/\r\n/g, '\n')
  const requestIndex = normalized.indexOf(IDE_REQUEST_HEADER)
  if (requestIndex < 0) {
    return { request: input, context: '' }
  }
  const context = normalized.slice(0, requestIndex).trim()
  const afterHeader = normalized.slice(requestIndex + IDE_REQUEST_HEADER.length)
  const request = afterHeader.replace(/^\s+/, '')
  if (!request) {
    return { request: input, context }
  }
  return { request, context }
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | (string & {})
  content: string
  createdAt?: Date
  experimental_attachments?: Attachment[]
  toolInvocations?: ToolInvocation[]
  parts?: MessagePart[]
}

export interface ChatMessageProps extends Message {
  animation?: Animation
  actions?: React.ReactNode
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  id,
  role,
  content,
  createdAt,
  animation = 'none',
  actions,
  experimental_attachments,
  toolInvocations,
  parts
}) => {
  const files = useMemo(() => {
    return experimental_attachments?.map((attachment) => {
      const dataArray = dataUrlToUint8Array(attachment.url)
      const file = new File([dataArray], attachment.name ?? 'Unknown', {
        type: attachment.contentType
      })
      return file
    })
  }, [experimental_attachments])

  const isUser = role === 'user'
  const { request: userRequestContent, context: userContext } = useMemo(() => {
    if (!isUser) {
      return { request: content, context: '' }
    }
    return splitIdeInjectedContext(content)
  }, [content, isUser])
  void createdAt

  if (isUser) {
    return (
      <div
        id={id}
        className={cn('flex flex-col shrink-0 w-full', isUser ? 'items-end' : 'items-start')}
      >
        {files ? (
          <div className="mb-1 flex flex-wrap gap-2">
            {files.map((file, index) => {
              return <FilePreview file={file} key={index} />
            })}
          </div>
        ) : null}

        <div className="flex w-full justify-end">
          <div className="relative max-w-[80%]">
            {userContext ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="查看 IDE 上下文"
                  className="absolute -left-6 top-1 z-10 flex h-5 w-5 items-center justify-center text-muted-foreground/70 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ring"
                  >
                  <TextSelect className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="left"
                  align="end"
                  className="max-w-xs whitespace-pre-wrap text-left leading-relaxed text-background"
                >
                  {userContext}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <div className={cn(chatBubbleVariants({ isUser, animation }), 'max-w-full')}>
              <MarkdownRenderer>{userRequestContent}</MarkdownRenderer>
            </div>
          </div>
        </div>

        {/* 时间展示已移除 */}
      </div>
    )
  }

  if (parts && parts.length > 0) {
    return parts.map((part, index) => {
      if (part.type === 'text') {
        return (
          <div
            className={cn('flex flex-col', isUser ? 'items-end' : 'items-start')}
            key={`text-${index}`}
          >
            <div className={cn(chatBubbleVariants({ isUser, animation }))}>
              <MarkdownRenderer>{part.text}</MarkdownRenderer>
              {actions ? (
                <div className="absolute -bottom-4 right-2 flex space-x-1 rounded-lg border bg-background p-1 text-foreground opacity-0 transition-opacity group-hover/message:opacity-100">
                  {actions}
                </div>
              ) : null}
            </div>

            {/* 时间展示已移除 */}
          </div>
        )
      } else if (part.type === 'reasoning') {
        return <ReasoningBlock key={`reasoning-${index}`} part={part} />
      } else if (part.type === 'tool-invocation') {
        return <ToolCall key={`tool-${index}`} toolInvocations={[part.toolInvocation]} />
      }
      return null
    })
  }

  if (toolInvocations && toolInvocations.length > 0) {
    return <ToolCall toolInvocations={toolInvocations} />
  }

  return (
    <div
      id={id}
      className={cn('flex flex-col shrink-0 max-w-full', isUser ? 'items-end' : 'items-start')}
    >
      <div className={cn(chatBubbleVariants({ isUser, animation }))}>
        <MarkdownRenderer>{content}</MarkdownRenderer>
        {actions ? (
          <div className="absolute -bottom-4 right-2 flex space-x-1 rounded-lg border bg-background p-1 text-foreground opacity-0 transition-opacity group-hover/message:opacity-100">
            {actions}
          </div>
        ) : null}
      </div>

      {/* 时间展示已移除 */}
    </div>
  )
}

function dataUrlToUint8Array(data: string) {
  const base64 = data.includes(',') ? data.split(',')[1] : data
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

const ReasoningBlock = ({ part }: { part: ReasoningPart }) => {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="mb-2 flex flex-col items-start sm:max-w-[70%]">
      <Collapsible
        open={isOpen}
        onOpenChange={setIsOpen}
        className="group w-full overflow-hidden rounded-lg border bg-muted/50"
      >
        <div className="flex items-center p-2">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-4 w-4 transition-transform group-data-[state=open]:rotate-90" />
              <span>Thinking</span>
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent forceMount>
          <motion.div
            initial={false}
            animate={isOpen ? 'open' : 'closed'}
            variants={{
              open: { height: 'auto', opacity: 1 },
              closed: { height: 0, opacity: 0 }
            }}
            transition={{ duration: 0.3, ease: [0.04, 0.62, 0.23, 0.98] }}
            className="border-t"
          >
            <div className="p-2">
              <div className="whitespace-pre-wrap text-xs">{part.reasoning}</div>
            </div>
          </motion.div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function ToolCall({ toolInvocations }: Pick<ChatMessageProps, 'toolInvocations'>) {
  if (!toolInvocations?.length) return null

  return (
    <div className="flex flex-col items-start gap-2">
      {toolInvocations.map((invocation, index) => {
        const isCancelled = invocation.state === 'result' && invocation.result.__cancelled === true

        if (isCancelled) {
          return (
            <div
              key={index}
              className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
            >
              <Ban className="h-4 w-4" />
              <span>
                Cancelled{' '}
                <span className="font-mono">
                  {'`'}
                  {invocation.toolName}
                  {'`'}
                </span>
              </span>
            </div>
          )
        }

        switch (invocation.state) {
          case 'partial-call':
          case 'call':
            return (
              <div
                key={index}
                className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
              >
                <Terminal className="h-4 w-4" />
                <span>
                  Calling{' '}
                  <span className="font-mono">
                    {'`'}
                    {invocation.toolName}
                    {'`'}
                  </span>
                  ...
                </span>
                <Loader2 className="h-3 w-3 animate-spin" />
              </div>
            )
          case 'result':
            return (
              <div
                key={index}
                className="flex flex-col gap-1.5 rounded-lg border bg-muted/50 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Code2 className="h-4 w-4" />
                  <span>
                    Result from{' '}
                    <span className="font-mono">
                      {'`'}
                      {invocation.toolName}
                      {'`'}
                    </span>
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-foreground">
                  {JSON.stringify(invocation.result, null, 2)}
                </pre>
              </div>
            )
          default:
            return null
        }
      })}
    </div>
  )
}
