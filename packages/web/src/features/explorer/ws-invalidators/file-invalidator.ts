import type { QueryClient } from '@tanstack/react-query'
import { ws } from '@/lib/ws/singleton'
import { createRafBatch, dirname } from './invalidation-utils'

export function installFileInvalidator(
  qc: QueryClient,
  ctx: { getCurrentRoot: () => string }
) {
  if (!ws.enabled) return () => {}

  const digestHitAt = new Map<string, number>()
  const DEDUP_WINDOW_MS = 800
  const pendingFiles = new Set<string>()
  const rafBatch = createRafBatch()

  const flush = () => {
    const root = ctx.getCurrentRoot()
    if (pendingFiles.size > 0) {
      const files = Array.from(pendingFiles)
      pendingFiles.clear()
      for (const path of files) {
        qc.invalidateQueries({ predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'file' && q.queryKey[1] === path })
        const d = dirname(path)
        qc.invalidateQueries({ queryKey: ['tree', root, d] })
      }
    }
  }

  const sub = ws.notification$('file.changed').subscribe((p: any) => {
    const path = String(p?.path || '')
    if (!path) return
    const hasDigest = Boolean(p?.digest)
    const now = Date.now()
    if (hasDigest) {
      digestHitAt.set(path, now)
      pendingFiles.add(path)
      rafBatch(flush)
      return
    }
    const last = digestHitAt.get(path) || 0
    if (now - last <= DEDUP_WINDOW_MS) return
    pendingFiles.add(path)
    rafBatch(flush)
  })

  return () => {
    try { sub.unsubscribe() } catch {}
    pendingFiles.clear()
    digestHitAt.clear()
  }
}

