import type { QueryClient } from '@tanstack/react-query'
import { installFileInvalidator } from './file-invalidator'
import { installTreeInvalidator } from './tree-invalidator'
import { installAnnotationsInvalidator } from './annotations-invalidator'

export function installExplorerInvalidators(
  qc: QueryClient,
  ctx: { getCurrentRoot: () => string; getCurrentDir: () => string }
) {
  const cleanups = [
    installFileInvalidator(qc, { getCurrentRoot: ctx.getCurrentRoot }),
    installTreeInvalidator(qc, ctx),
    installAnnotationsInvalidator(qc)
  ]
  return () => {
    for (const fn of cleanups) {
      try {
        fn?.()
      } catch {}
    }
  }
}
