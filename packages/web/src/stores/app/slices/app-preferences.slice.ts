import type { AppStore, AppStoreCreator } from '../types'

type Slice = Pick<
  AppStore,
  | 'explorerSidebarTab'
  | 'wrap'
  | 'mdPreview'
  | 'theme'
  | 'setExplorerSidebarTab'
  | 'toggleWrap'
  | 'toggleMdPreview'
  | 'setTheme'
  | 'toggleTheme'
>

export const createAppPreferencesSlice: AppStoreCreator<Slice> = (set, get) => ({
  explorerSidebarTab: 'files',
  wrap: false,
  mdPreview: false,
  theme: 'light',
  setExplorerSidebarTab: (tab) => set({ explorerSidebarTab: tab }),
  toggleWrap: () => set({ wrap: !get().wrap }),
  toggleMdPreview: () => set({ mdPreview: !get().mdPreview }),
  setTheme: (t) => set({ theme: t }),
  toggleTheme: () => set({ theme: get().theme === 'dark' ? 'light' : 'dark' })
})
