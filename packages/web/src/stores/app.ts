import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type ActivePane = 'files' | 'annotations'

type AppState = {
  currentDir: string
  selectedPath: string | null
  pageSize: number
  activePane: ActivePane
  wrap: boolean
  mdPreview: boolean
  setCurrentDir: (dir: string) => void
  setSelectedPath: (p: string | null) => void
  setPageSize: (n: number) => void
  setActivePane: (p: ActivePane) => void
  toggleWrap: () => void
  toggleMdPreview: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentDir: '.',
      selectedPath: null,
      pageSize: 1000,
      activePane: 'files',
      wrap: false,
      mdPreview: false,
      setCurrentDir: (dir) => set({ currentDir: dir }),
      setSelectedPath: (p) => set({ selectedPath: p }),
      setPageSize: (n) => set({ pageSize: n }),
      setActivePane: (p) => set({ activePane: p }),
      toggleWrap: () => set({ wrap: !get().wrap }),
      toggleMdPreview: () => set({ mdPreview: !get().mdPreview })
    }),
    { name: 'ailoom.app' }
  )
)
