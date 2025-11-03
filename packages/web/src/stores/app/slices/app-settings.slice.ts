import type { AppStore, AppStoreCreator } from '../types'

type Slice = Pick<AppStore, 'codexHome' | 'setCodexHome'>

export const DEFAULT_CODEX_HOME = '~/.codex'

export function normalizeCodexHomeInput(path: string) {
  const next = path ?? ''
  const trimmed = next.trim()
  return trimmed.length > 0 ? trimmed : DEFAULT_CODEX_HOME
}

export const createAppSettingsSlice: AppStoreCreator<Slice> = (set) => ({
  codexHome: DEFAULT_CODEX_HOME,
  setCodexHome: (path) => {
    set({ codexHome: normalizeCodexHomeInput(path) })
  }
})
