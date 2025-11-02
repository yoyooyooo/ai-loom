'use client'

import { useCallback, useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/app'

const STYLE_ID = 'theme-toggle-view-transition'

function isViewTransitionSupported() {
  if (typeof document === 'undefined') return false
  const hasAPI = typeof (document as any).startViewTransition === 'function'
  const hasCSS =
    typeof (window as any).CSS !== 'undefined' &&
    typeof (window as any).CSS.supports === 'function' &&
    (window as any).CSS.supports('view-transition-name: none')
  const prefersReduced =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 仅当 API 与 CSS 都可用且未启用减少动效时才启用视图过渡
  return hasAPI && hasCSS && !prefersReduced
}

function injectViewTransition(x?: number, y?: number) {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  const style =
    existing ??
    Object.assign(document.createElement('style'), {
      id: STYLE_ID
    })
  style.textContent = `
  ::view-transition-group(root) {
    animation-duration: 420ms;
    animation-timing-function: cubic-bezier(0.16,1,0.3,1);
  }
  ::view-transition-image-pair(root) {
    isolation: isolate;
  }
  ::view-transition {
    pointer-events: none;
  }
  ::view-transition-new(root) {
    clip-path: circle(0% at var(--theme-toggle-x, 50%) var(--theme-toggle-y, 50%));
    animation: theme-toggle-reveal 420ms forwards;
  }
  ::view-transition-old(root) {
    animation: none;
  }
  @keyframes theme-toggle-reveal {
    to {
      clip-path: circle(150% at var(--theme-toggle-x, 50%) var(--theme-toggle-y, 50%));
    }
  }
  `
  if (!existing) document.head.appendChild(style)
  const root = document.documentElement
  if (x != null && y != null) {
    const rect = root.getBoundingClientRect()
    const px = ((x - rect.left) / rect.width) * 100
    const py = ((y - rect.top) / rect.height) * 100
    root.style.setProperty('--theme-toggle-x', `${px}%`)
    root.style.setProperty('--theme-toggle-y', `${py}%`)
  } else {
    root.style.setProperty('--theme-toggle-x', '50%')
    root.style.setProperty('--theme-toggle-y', '50%')
  }
  window.setTimeout(() => {
    if (style.isConnected) style.remove()
  }, 600)
}

export type ThemeToggleProps = {
  className?: string
  showLabel?: boolean
}

export function ThemeToggle({ className, showLabel }: ThemeToggleProps) {
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = theme === 'dark'

  const handleToggle = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const runToggle = () => toggleTheme()
      const supports = isViewTransitionSupported()
      if (supports) {
        // 先注入样式与坐标变量，再启动视图过渡，避免新版本浏览器在过渡开始时就锁定样式，导致动画不生效
        try {
          injectViewTransition(event.clientX, event.clientY)
        } catch {}
        const vt = (document as any).startViewTransition?.(() => runToggle())
        vt?.finished?.catch(() => {})
      } else {
        runToggle()
      }
    },
    [toggleTheme]
  )

  return (
    <button
      type="button"
      onClick={handleToggle}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-full border border-border/60 bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        showLabel ? 'w-full justify-start' : 'size-10 px-0 py-0',
        className
      )}
      aria-label={isDark ? '切换为浅色模式' : '切换为深色模式'}
    >
      <span className="relative inline-flex items-center justify-center">
        <Sun
          className={cn(
            'size-4 transition-all duration-300',
            isDark ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100'
          )}
        />
        <Moon
          className={cn(
            'absolute size-4 transition-all duration-300',
            isDark ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0'
          )}
        />
      </span>
      {showLabel && mounted ? <span>{isDark ? '深色模式' : '浅色模式'}</span> : null}
    </button>
  )
}

export default ThemeToggle
