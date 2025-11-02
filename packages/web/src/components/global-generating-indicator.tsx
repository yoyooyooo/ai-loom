import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { generatingState$ } from '@/features/codex-chat/services/generating-aggregator'
import { cn } from '@/lib/utils'
import { useObservableState } from 'observable-hooks'
import { map } from 'rxjs/operators'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNavigate } from 'react-router-dom'

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

  const label = `进行中：${count}`
  const active = count > 0
  if (!active) return null

  const renderList = () => {
    if (!items || items.length === 0) return <span className="text-xs">暂无</span>
    return (
      <div className="max-w-64 max-h-72 overflow-auto">
        <div className="mb-1 text-[10px] opacity-70">进行中的会话（点击跳转）</div>
        <ul className="space-y-1">
          {items.map((key: string) => {
            const [maybeProvider, maybeCid] = key.includes('|') ? key.split('|') : ['', key]
            const cid = maybeCid || key
            const provider = maybeProvider || ''
            const short = cid.length > 8 ? `${cid.slice(0, 4)}…${cid.slice(-3)}` : cid
            const text = provider ? `${provider}:${short}` : short
            return (
              <li key={key}>
                <button
                  type="button"
                  className="w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-background/20"
                  onClick={() => navigate(`/chat/${encodeURIComponent(cid)}`)}
                >
                  {text}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('relative inline-flex items-center cursor-pointer', className)} aria-label={label}>
          <div className={cn('flex aspect-square size-9 items-center justify-center rounded-lg border text-base border-primary/60 bg-primary text-primary-foreground shadow-sm')}>
            <Loader2 className="size-5 animate-spin" style={{ animationDuration: '1.2s' }} />
          </div>
          <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-5 text-primary-foreground shadow">
            {count}
          </span>
          {showLabel ? <span className="ml-2 text-sm text-muted-foreground">{label}</span> : null}
        </div>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{renderList()}</TooltipContent>
    </Tooltip>
  )
}

export default GlobalGeneratingIndicator
