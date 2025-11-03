import { Loader2 } from 'lucide-react'
import { generatingState$ } from '@/features/codex-chat/services/generating-aggregator'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useObservableState } from 'observable-hooks'
import { map } from 'rxjs/operators'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router-dom'
import { useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

export type GlobalGeneratingIndicatorProps = {
  className?: string
  showLabel?: boolean
}

export function GlobalGeneratingIndicator({ className, showLabel }: GlobalGeneratingIndicatorProps) {
  const navigate = useNavigate()
  const [state] = useObservableState(
    () =>
      generatingState$().pipe(
        map((s) => {
          const entries = Object.entries(s.byKey || {})
            .filter(([, v]: any) => !!v?.generating)
            .map(([k]) => k)
          return { count: entries.length, items: entries }
        })
      ),
    { count: 0, items: [] as string[] }
  )
  const count = state.count
  const items = state.items

  const storeVersion = useChatTurnStore((s) => s.version)
  const parsedItems = useMemo(() => {
    if (!items || items.length === 0) return []
    const getPreview = useChatTurnStore.getState().getLastAssistantPreview
    return items.map((key: string) => {
      const [maybeProvider, maybeCid] = key.includes('|') ? key.split('|') : ['', key]
      const cid = maybeCid || key
      const provider = maybeProvider || ''
      const short = cid.length > 8 ? `${cid.slice(0, 4)}…${cid.slice(-3)}` : cid
      const fallback = provider ? `${provider}:${short}` : short
      const preview = getPreview ? getPreview(cid, 80) : null
      const trimmedPreview = preview?.trim()
      const display = trimmedPreview
        ? provider
          ? `${provider} · ${trimmedPreview}`
          : trimmedPreview
        : fallback
      return {
        key,
        cid,
        provider,
        preview: trimmedPreview,
        fallback,
        display
      }
    })
  }, [items, storeVersion])

  const label = `进行中：${count}`
  const active = count > 0
  if (!active) return null

  const renderList = () => {
    if (!parsedItems || parsedItems.length === 0) {
      return (
        <DropdownMenuItem disabled className="text-xs text-muted-foreground">
          暂无
        </DropdownMenuItem>
      )
    }

    return (
      <div className="max-h-72 overflow-auto">
        {parsedItems.map((item) => {
          return (
            <DropdownMenuItem
              key={item.key}
              onSelect={(event) => {
                event.preventDefault()
                navigate(`/chat/${encodeURIComponent(item.cid)}`)
              }}
              className="cursor-pointer text-xs"
              title={item.preview || item.fallback}
            >
              {item.display}
            </DropdownMenuItem>
          )
        })}
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'relative inline-flex items-center gap-2 px-2 py-1 h-auto',
            'hover:bg-transparent focus-visible:outline-none focus-visible:ring-0',
            className
          )}
          aria-label={label}
        >
          <div className={cn('flex aspect-square size-9 items-center justify-center rounded-lg border text-base border-primary/60 bg-primary text-primary-foreground shadow-sm')}>
            <Loader2 className="size-5 animate-spin" style={{ animationDuration: '1.2s' }} />
          </div>
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-5 text-primary-foreground shadow">
            {count}
          </span>
          {showLabel ? <span className="ml-2 text-sm text-muted-foreground">{label}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        <DropdownMenuLabel>进行中的会话</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {renderList()}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default GlobalGeneratingIndicator
