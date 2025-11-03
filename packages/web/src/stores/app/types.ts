import type { StateCreator } from 'zustand'

export type AppStore = {
  currentRoot: string
  currentDir: string
  selectedPath: string | null
  pageSize: number
  explorerSidebarTab: 'files' | 'annotations'
  wrap: boolean
  mdPreview: boolean
  theme: 'light' | 'dark'
  codexHome: string
  setCurrentDir: (dir: string) => void
  setCurrentRoot: (r: string) => void
  setSelectedPath: (p: string | null) => void
  setPageSize: (n: number) => void
  setExplorerSidebarTab: (tab: 'files' | 'annotations') => void
  toggleWrap: () => void
  toggleMdPreview: () => void
  setTheme: (t: 'light' | 'dark') => void
  toggleTheme: () => void
  setCodexHome: (path: string) => void
}

export type AppStoreCreator<TSlice> = StateCreator<
  AppStore,
  [
    ['zustand/devtools', never],
    ['zustand/persist', unknown],
    ['zustand/immer', never],
    ['zustand/subscribeWithSelector', never]
  ],
  [],
  TSlice
>
