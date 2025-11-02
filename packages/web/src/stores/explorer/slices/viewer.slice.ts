import type { ExplorerStore, ExplorerStoreCreator } from '../types'

type Slice = Pick<
  ExplorerStore,
  | 'startLine'
  | 'full'
  | 'chunkInfo'
  | 'revealNonce'
  | 'setStartLine'
  | 'enterFull'
  | 'exitFull'
  | 'setChunkInfo'
  | 'bumpReveal'
>

export const createViewerSlice: ExplorerStoreCreator<Slice> = (set) => ({
  startLine: 1,
  full: null,
  chunkInfo: null,
  revealNonce: 0,
  setStartLine: (n) => set({ startLine: n }),
  enterFull: (f) => set({ full: f }),
  exitFull: () => set({ full: null }),
  setChunkInfo: (c) => set({ chunkInfo: c }),
  bumpReveal: () => set((s) => ({ revealNonce: s.revealNonce + 1 }))
})
