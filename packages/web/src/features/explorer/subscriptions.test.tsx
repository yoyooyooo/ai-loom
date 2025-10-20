import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useExplorerSubscriptions } from '@/features/explorer/subscriptions'
import { useAppStore } from '@/stores/app'

vi.mock('@/lib/ws/singleton', () => {
  const calls: any[] = []
  const subs: any[] = []
  const ws = {
    enabled: true,
    subscribeTopic$: (topic: string, filter: any) => {
      calls.push({ topic, filter })
      return {
        subscribe: (_fn: any) => {
          const sub = { unsubscribe: vi.fn() }
          subs.push(sub)
          return sub
        }
      }
    }
  }
  const __getCalls = () => calls
  const __getSubs = () => subs
  return { ws, __getCalls, __getSubs }
})

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only helpers
import { __getCalls, __getSubs } from '@/lib/ws/singleton'

describe('explorer subscriptions', () => {
  it('subscribes to tree/annotations and current file/prefix based on store', async () => {
    act(() => {
      useAppStore.setState({ currentDir: '.', selectedPath: null })
    })
    const { unmount } = renderHook(() => useExplorerSubscriptions())

    const calls1 = __getCalls()
    expect(calls1.some((c: any) => c.topic === 'tree' && c.filter?.dir === '.')).toBe(true)
    expect(calls1.some((c: any) => c.topic === 'annotations')).toBe(true)
    expect(calls1.some((c: any) => c.topic === 'file' && c.filter?.prefix)).toBe(false)

    act(() => {
      useAppStore.getState().setSelectedPath('src/a.txt')
    })
    const calls2 = __getCalls()
    expect(calls2.some((c: any) => c.topic === 'file' && c.filter?.path === 'src/a.txt')).toBe(true)

    act(() => {
      useAppStore.getState().setCurrentDir('src')
    })
    const calls3 = __getCalls()
    expect(calls3.some((c: any) => c.topic === 'tree' && c.filter?.dir === 'src')).toBe(true)
    expect(calls3.some((c: any) => c.topic === 'file' && c.filter?.prefix === 'src/')).toBe(true)

    const subsBefore = __getSubs().slice()
    unmount()
    for (const s of subsBefore) {
      expect(s.unsubscribe).toHaveBeenCalled()
    }
  })

  it('rebuilds file subscription when selectedPath changes', async () => {
    act(() => {
      useAppStore.setState({ currentDir: '.', selectedPath: 'src/a.txt' as any })
    })
    const { rerender } = renderHook(() => useExplorerSubscriptions())
    const calls1 = __getCalls()
    expect(calls1.some((c: any) => c.topic === 'file' && c.filter?.path === 'src/a.txt')).toBe(true)

    act(() => {
      useAppStore.getState().setSelectedPath('src/b.txt')
    })
    rerender()
    const calls2 = __getCalls()
    expect(calls2.some((c: any) => c.topic === 'file' && c.filter?.path === 'src/b.txt')).toBe(true)

    const subs = __getSubs()
    const anyUnsubCalled = subs.some((s: any) => s.unsubscribe.mock.calls.length > 0)
    expect(anyUnsubCalled).toBe(true)
  })
})

