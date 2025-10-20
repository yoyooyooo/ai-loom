import type { QueryClient } from '@tanstack/react-query'
import { ws } from '@/lib/ws/singleton'
import { createRafBatch, calcMinimalDirs, dirname } from './invalidation-utils'

export function installTreeInvalidator(
  qc: QueryClient,
  ctx: { getCurrentRoot: () => string; getCurrentDir: () => string }
) {
  if (!ws.enabled) return () => {}

  const pendingDirs = new Set<string>()
  const rafBatch = createRafBatch()

  const flush = () => {
    const root = ctx.getCurrentRoot()
    if (pendingDirs.size > 0) {
      const dirs = Array.from(pendingDirs)
      pendingDirs.clear()
      for (const d of dirs) {
        qc.invalidateQueries({ queryKey: ['tree', root, d] })
      }
    }
  }

  const s1 = ws.notification$('tree.changed').subscribe((p: any) => {
    const dir = String(p?.dir || '')
    const hasImpacted = Object.prototype.hasOwnProperty.call(p || {}, 'impactedPaths')
    const impacted: string[] = Array.isArray(p?.impactedPaths) ? p.impactedPaths : []
    const truncated = Boolean(p?.summary?.truncated)
    if (truncated || !hasImpacted) {
      qc.invalidateQueries({ queryKey: ['tree', ctx.getCurrentRoot(), ctx.getCurrentDir() || '.'] })
      return
    }
    if (dir) pendingDirs.add(dir)
    const minimal = calcMinimalDirs(impacted.map(dirname))
    for (const d of minimal) pendingDirs.add(d)
    rafBatch(flush)
  })

  const s2 = ws.notification$('session.resync').subscribe(() => {
    qc.invalidateQueries({ queryKey: ['tree', ctx.getCurrentRoot(), ctx.getCurrentDir() || '.'] })
  })

  return () => {
    try { s1.unsubscribe() } catch {}
    try { s2.unsubscribe() } catch {}
    pendingDirs.clear()
  }
}

