import type { HTMLAttributes, ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

type EmptyStateProps = {
  title: string
  description?: string
  icon?: ReactNode
  action?: ReactNode
} & HTMLAttributes<HTMLDivElement>

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center text-muted-foreground',
        className
      )}
      {...rest}
    >
      <div className="flex items-center justify-center rounded-full border border-dashed border-border/60 p-3 text-foreground/60">
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground/80">{title}</p>
        {description ? <p className="text-xs leading-relaxed text-muted-foreground/80">{description}</p> : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}

type LoadingPlaceholderProps = {
  count?: number
  itemClassName?: string
} & HTMLAttributes<HTMLDivElement>

export function LoadingPlaceholder({
  count = 3,
  itemClassName,
  className,
  ...rest
}: LoadingPlaceholderProps) {
  return (
    <div className={cn('flex flex-col gap-4 py-4', className)} {...rest}>
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className={cn('space-y-2', itemClassName)}>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ))}
    </div>
  )
}
