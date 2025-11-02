import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'
import { subscribeWithSelector } from 'zustand/middleware'

import type { ExplorerStore } from './types'
import { createSelectionSlice } from './slices/selection.slice'
import { createViewerSlice } from './slices/viewer.slice'
import { createExplorerActions } from './slices/actions.slice'

export const useExplorerStore = create<ExplorerStore>()(
  devtools(
    subscribeWithSelector(
      immer((...args) => ({
        ...createSelectionSlice(...args),
        ...createViewerSlice(...args),
        ...createExplorerActions(...args)
      }))
    ),
    { name: 'ExplorerStore' }
  )
)
