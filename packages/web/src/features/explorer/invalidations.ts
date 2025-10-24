import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app'
import { installExplorerInvalidators } from './ws-invalidators'

export function useExplorerInvalidations() {
  const qc = useQueryClient()
  useEffect(() => {
    const cleanup = installExplorerInvalidators(qc, {
      getCurrentRoot: () => useAppStore.getState().currentRoot,
      getCurrentDir: () => useAppStore.getState().currentDir
    })
    return () => {
      try {
        cleanup()
      } catch {}
    }
  }, [qc])
}
