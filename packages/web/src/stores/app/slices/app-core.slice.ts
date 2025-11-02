import type { AppStore, AppStoreCreator } from '../types'

type Slice = Pick<
  AppStore,
  | 'currentRoot'
  | 'currentDir'
  | 'selectedPath'
  | 'pageSize'
  | 'setCurrentDir'
  | 'setCurrentRoot'
  | 'setSelectedPath'
  | 'setPageSize'
>

export const createAppCoreSlice: AppStoreCreator<Slice> = (set) => ({
  currentRoot: '.',
  currentDir: '.',
  selectedPath: null,
  pageSize: 1000,
  setCurrentDir: (dir) => set({ currentDir: dir }),
  setCurrentRoot: (r) => set({ currentRoot: r }),
  setSelectedPath: (p) => set({ selectedPath: p }),
  setPageSize: (n) => set({ pageSize: n })
})
