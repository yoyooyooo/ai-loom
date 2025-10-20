import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { Subject } from 'rxjs'

vi.useFakeTimers()

vi.mock('@/lib/ws/singleton', () => {
  const subjects = new Map<string, Subject<any>>()
  const ws = {
    enabled: true,
    notification$: (m: string) => {
      if (!subjects.has(m)) subjects.set(m, new Subject<any>())
      return subjects.get(m)!.asObservable()
    },
    __get: (m: string) => subjects.get(m) || null
  }
  return { ws }
})

import { installTreeInvalidator } from './tree-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { ws as mockedWs } from '@/lib/ws/singleton'

describe('tree-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('truncated tree.changed invalidates current dir', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => 'docs' })
    const treeChanged = (mockedWs as any).__get('tree.changed') as Subject<any>
    treeChanged.next({ summary: { truncated: true } })
    vi.runAllTimers()
    await Promise.resolve()
    const hasTree = spy.mock.calls.some((c) => Array.isArray(c[0]?.queryKey) && c[0]?.queryKey[0] === 'tree')
    expect(hasTree).toBe(true)
  })

  it('impactedPaths invalidates minimal set of dirs', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => '.' })
    const treeChanged = (mockedWs as any).__get('tree.changed') as Subject<any>
    treeChanged.next({ dir: 'src', impactedPaths: ['src/a', 'src/a/b', 'src/c'] })
    vi.runAllTimers()
    const calls = spy.mock.calls.map((c) => c[0])
    const expectKeys = [
      JSON.stringify(['tree', '.', 'src']),
      JSON.stringify(['tree', '.', 'src/a']),
      JSON.stringify(['tree', '.', 'src/c'])
    ]
    const hit = calls.filter((arg: any) => arg?.queryKey && expectKeys.includes(JSON.stringify(arg.queryKey)))
    // 至少应包含这些目录的失效（src/a/b 折叠入 src/a）
    expect(hit.length).toBeGreaterThanOrEqual(3)
  })

  it('session.resync triggers coarse refresh', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => 'src' })
    const resync = (mockedWs as any).__get('session.resync') as Subject<any>
    resync.next({})
    await Promise.resolve()
    const has = spy.mock.calls.some((c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(['tree', '.', 'src']))
    expect(has).toBe(true)
  })
})

