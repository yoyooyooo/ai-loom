import type { ExplorerStore, ExplorerStoreCreator } from '../types'

type Slice = Pick<
  ExplorerStore,
  | 'selection'
  | 'showToolbar'
  | 'comment'
  | 'activeAnnId'
  | 'pendingJump'
  | 'setSelection'
  | 'openToolbar'
  | 'closeToolbar'
  | 'setComment'
  | 'setActiveAnnId'
  | 'setPendingJump'
>

export const createSelectionSlice: ExplorerStoreCreator<Slice> = (set) => ({
  selection: null,
  showToolbar: false,
  comment: '',
  activeAnnId: null,
  pendingJump: null,
  setSelection: (s) => set({ selection: s }),
  openToolbar: () => set({ showToolbar: true }),
  closeToolbar: () => set({ showToolbar: false, selection: null, activeAnnId: null }),
  setComment: (c) => set({ comment: c }),
  setActiveAnnId: (id) => set({ activeAnnId: id }),
  setPendingJump: (p) => set({ pendingJump: p })
})
