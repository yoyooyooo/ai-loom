import React, { useMemo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { Terminal, Copy, Check, List } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useChatTurnStore, chatTurnSelectors } from '@/features/codex-chat/stores/chat-turns'
import {
  getChatScroller,
  smoothScrollElement
} from '@/features/codex-chat/stores/chat-scroll-utils'

export type ChatTopToolbarProps = {
  kind: 'info' | 'error'
  message?: string | null
  conversationId?: string | null
  onCopy?: () => void
  copied?: boolean
}

export function ChatTopToolbar({
  kind,
  message,
  conversationId,
  onCopy,
  copied
}: ChatTopToolbarProps) {
  const cleaned = (message || '').trim()
  const showCopy = Boolean(conversationId)
  const wrapperCls =
    (kind === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground') +
    ' px-4 py-2 text-sm flex items-center justify-between'

  const turns = useChatTurnStore((s) => chatTurnSelectors.currentTurns(s))
  const userTurns = useMemo(
    () => turns.filter((t) => (t.user?.text || '').trim().length > 0),
    [turns]
  )
  const summarize = (input: string, max = 36) => {
    try {
      const raw = String(input || '').replace(/\r/g, '')
      const first = (raw.split(/\n/).find((ln) => ln.trim().length > 0) || '').trim()
      return first.length > max ? first.slice(0, max) + '…' : first
    } catch {
      return ''
    }
  }

  function scrollUserToTop(seq: number, convId?: string | null) {
    const scroller = getChatScroller()
    if (!scroller) return
    const conv = convId || 'local'
    const msgId = `${conv}:${seq}:u`
    const anchor = typeof document !== 'undefined' ? document.getElementById(msgId) : null
    if (!anchor) return
    const getTo = () => {
      const crect = scroller.getBoundingClientRect()
      const trect = anchor.getBoundingClientRect()
      return scroller.scrollTop + (trect.top - crect.top)
    }
    requestAnimationFrame(() => {
      smoothScrollElement(scroller, getTo, {
        interruptOnUser: true,
        freezeTo: true,
        nearDuration: 0.33,
        farDuration: 0.41,
        extraDuration: 0.01,
        easing: [0.45, 0.08, 1.0, 1.0]
      })
    })
  }

  return (
    <div className={wrapperCls}>
      {cleaned ? (
        <span className="min-w-0 flex-1 truncate">{cleaned}</span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="跳转到用户消息"
            >
              <List className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="max-h-[80vh] w-[300px]"
            onCloseAutoFocus={(e) => e.preventDefault()}
            container={getChatScroller()}
          >
            <DropdownMenuLabel>用户节点</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {userTurns.length === 0 ? (
              <DropdownMenuItem disabled>暂无用户消息</DropdownMenuItem>
            ) : (
              userTurns.map((t, idx) => {
                const raw = String(t.user?.text || '')
                const label = summarize(raw) || '（空）'
                return (
                  <Tooltip key={t.id}>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        onSelect={() =>
                          requestAnimationFrame(() => scrollUserToTop(t.seq, t.conversationId))
                        }
                      >
                        <span className="text-muted-foreground mr-2 w-6 shrink-0 text-right">
                          {idx + 1}.
                        </span>
                        <span className="truncate">{label}</span>
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    {raw ? (
                      <TooltipContent
                        side="left"
                        sideOffset={8}
                        className="inline-block w-fit max-w-[min(70vw,520px)] whitespace-pre-wrap wrap-break-word"
                      >
                        {raw}
                      </TooltipContent>
                    ) : null}
                  </Tooltip>
                )
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {showCopy ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative h-6 w-6"
                aria-label="复制 CLI 命令以重启会话"
                onClick={onCopy}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <Check
                    className={`h-4 w-4 transition-transform ease-in-out ${copied ? 'scale-100' : 'scale-0'}`}
                  />
                </div>
                <div
                  className={`transition-transform ease-in-out ${copied ? 'scale-0' : 'scale-100'}`}
                >
                  <div className="relative">
                    <Terminal className="h-4 w-4" />
                    <Copy className="h-3 w-3 absolute -right-0.5 -bottom-0.5 bg-background rounded" />
                  </div>
                </div>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              复制该命令到剪贴板，用于在 CLI 中重启此会话
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

export default ChatTopToolbar
