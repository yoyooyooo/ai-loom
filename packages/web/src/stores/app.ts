import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

type AppState = {
  currentRoot: string
  currentDir: string
  selectedPath: string | null
  pageSize: number
  explorerSidebarTab: 'files' | 'annotations'
  wrap: boolean
  mdPreview: boolean
  theme: 'light' | 'dark'
  setCurrentDir: (dir: string) => void
  setCurrentRoot: (r: string) => void
  setSelectedPath: (p: string | null) => void
  setPageSize: (n: number) => void
  setExplorerSidebarTab: (tab: 'files' | 'annotations') => void
  toggleWrap: () => void
  toggleMdPreview: () => void
  setTheme: (t: 'light' | 'dark') => void
  toggleTheme: () => void
}

export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (set, get) => ({
        currentRoot: '.',
        currentDir: '.',
      selectedPath: null,
      pageSize: 1000,
      explorerSidebarTab: 'files',
      wrap: false,
      mdPreview: false,
      theme: 'light',
      setCurrentDir: (dir) => set({ currentDir: dir }),
      setCurrentRoot: (r) => set({ currentRoot: r }),
      setSelectedPath: (p) => set({ selectedPath: p }),
      setPageSize: (n) => set({ pageSize: n }),
      setExplorerSidebarTab: (tab) => set({ explorerSidebarTab: tab }),
      toggleWrap: () => set({ wrap: !get().wrap }),
      toggleMdPreview: () => set({ mdPreview: !get().mdPreview }),
      setTheme: (t) => set({ theme: t }),
      toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' })
      }),
      { name: 'ailoom.app' }
    ),
    { name: 'AppStore' }
  )
)
