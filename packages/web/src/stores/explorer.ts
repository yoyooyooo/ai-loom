import { create } from 'zustand'

export type Selection = {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  selectedText: string
} | null

export type ChunkInfo = { start: number; end: number; total: number } | null

export type PendingJump = {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  id?: string
  comment?: string
} | null

export type FullEdit = { content: string; language: string; digest: string } | null

type ExplorerState = {
  startLine: number
  selection: Selection
  showToolbar: boolean
  comment: string
  activeAnnId: string | null
  full: FullEdit
  chunkInfo: ChunkInfo
  pendingJump: PendingJump
  revealNonce: number
  setStartLine: (n: number) => void
  setSelection: (s: Selection) => void
  openToolbar: () => void
  closeToolbar: () => void
  setComment: (c: string) => void
  setActiveAnnId: (id: string | null) => void
  enterFull: (f: NonNullable<FullEdit>) => void
  exitFull: () => void
  setChunkInfo: (c: NonNullable<ChunkInfo>) => void
  setPendingJump: (p: NonNullable<PendingJump>) => void
  consumePendingJump: () => PendingJump
  bumpReveal: () => void
  resetOnPathChange: () => void
}

export const useExplorerStore = create<ExplorerState>()((set, get) => ({
  startLine: 1,
  selection: null,
  showToolbar: false,
  comment: '',
  activeAnnId: null,
  full: null,
  chunkInfo: null,
  pendingJump: null,
  revealNonce: 0,
  setStartLine: (n) => set({ startLine: n }),
  setSelection: (s) => set({ selection: s }),
  openToolbar: () => set({ showToolbar: true }),
  closeToolbar: () => set({ showToolbar: false, selection: null, activeAnnId: null }),
  setComment: (c) => set({ comment: c }),
  setActiveAnnId: (id) => set({ activeAnnId: id }),
  enterFull: (f) => set({ full: f }),
  exitFull: () => set({ full: null }),
  setChunkInfo: (c) => set({ chunkInfo: c }),
  setPendingJump: (p) => set({ pendingJump: p }),
  consumePendingJump: () => {
    const pj = get().pendingJump
    set({ pendingJump: null })
    return pj
  },
  bumpReveal: () => set((s) => ({ revealNonce: s.revealNonce + 1 })),
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
}))
