import type { StateCreator } from 'zustand'

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

export type ExplorerStore = {
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

export type ExplorerStoreCreator<TSlice> = StateCreator<
  ExplorerStore,
  [['zustand/devtools', never], ['zustand/immer', never], ['zustand/subscribeWithSelector', never]],
  [],
  TSlice
>
