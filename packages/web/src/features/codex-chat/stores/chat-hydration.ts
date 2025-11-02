import { create } from 'zustand'

type HydrationState = {
  hydrating: Record<string, boolean>
  setHydrating: (conversationId: string, value: boolean) => void
  reset: () => void
}

export const useChatHydrationStore = create<HydrationState>((set) => ({
  hydrating: {},
  setHydrating: (conversationId, value) =>
    set((s) => ({ hydrating: { ...s.hydrating, [conversationId]: !!value } })),
  reset: () => set({ hydrating: {} })
}))

export function isConversationHydrating(conversationId?: string): boolean {
  if (!conversationId) return false
  try {
    const st = useChatHydrationStore.getState()
    return !!st.hydrating[conversationId]
  } catch {
    return false
  }
}
