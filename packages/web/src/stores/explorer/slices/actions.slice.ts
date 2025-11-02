import type { ExplorerStore, ExplorerStoreCreator } from '../types'

type Slice = Pick<ExplorerStore, 'consumePendingJump' | 'resetOnPathChange'>

export const createExplorerActions: ExplorerStoreCreator<Slice> = (set, get) => ({
  consumePendingJump: () => {
    const pj = get().pendingJump
    set({ pendingJump: null })
    return pj
  },
  resetOnPathChange: () =>
    set({
      startLine: 1,
      selection: null,
      showToolbar: false,
      full: null,
      chunkInfo: null,
      comment: '',
      activeAnnId: null,
      pendingJump: null,
      revealNonce: 0
    })
})
