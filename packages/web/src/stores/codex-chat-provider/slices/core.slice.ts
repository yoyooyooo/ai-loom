import type { CodexProviderStore, CodexProviderStoreCreator } from '../types'
import { DEFAULT_PROVIDER_ID, DEFAULT_SESSION_KEY } from '../types'
import { emptySession } from '../utils'

type Slice = Pick<CodexProviderStore, 'providerId' | 'sessions'>

export const createCoreSlice: CodexProviderStoreCreator<Slice> = () => ({
  providerId: DEFAULT_PROVIDER_ID,
  sessions: {
    [DEFAULT_SESSION_KEY]: emptySession()
  }
})
