import type { QueryClient } from '@tanstack/react-query'

export function dirname(p: string) {
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  if (i === 0) return '/'
  return p.slice(0, i)
}

export function calcMinimalDirs(dirs: string[]): string[] {
  const uniq = Array.from(new Set(dirs))
  uniq.sort((a, b) => a.length - b.length)
  const res: string[] = []
  for (const d of uniq) {
    if (!res.some((p) => d === p || d.startsWith(p.endsWith('/') ? p : p + '/'))) res.push(d)
  }
  return res
}

export function createRafBatch() {
  let rafScheduled = false
  return (fn: () => void) => {
    if (rafScheduled) return
    rafScheduled = true
    const run = () => {
      rafScheduled = false
      fn()
    }
    const shouldUseTimeout = (() => {
      try {
        if (typeof document !== 'undefined' && (document as any).visibilityState === 'hidden') return true
      } catch {}
      return typeof requestAnimationFrame === 'undefined'
    })()
    if (shouldUseTimeout) setTimeout(run, 50)
    else requestAnimationFrame(run)
  }
}

