import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { subscribeWithSelector } from 'zustand/middleware'

import type { AppStore } from './types'
import { createAppCoreSlice } from './slices/app-core.slice'
import { createAppPreferencesSlice } from './slices/app-preferences.slice'
import { createAppSettingsSlice } from './slices/app-settings.slice'

export const useAppStore = create<AppStore>()(
  devtools(
    persist(
      subscribeWithSelector(
        immer((...args) => ({
          ...createAppCoreSlice(...args),
          ...createAppPreferencesSlice(...args),
          ...createAppSettingsSlice(...args)
        }))
      ),
      { name: 'ailoom.app' }
    ),
    { name: 'AppStore' }
  )
)
