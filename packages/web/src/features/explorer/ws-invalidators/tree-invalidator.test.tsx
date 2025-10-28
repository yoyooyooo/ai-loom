import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { Subject } from 'rxjs'

vi.useFakeTimers()

vi.mock('@/lib/ws/singleton')

import { installTreeInvalidator } from './tree-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { __emit } from '@/lib/ws/singleton'

describe('tree-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('truncated tree.changed invalidates current dir', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => 'docs' })
    __emit('tree.changed', { summary: { truncated: true } })
    vi.runAllTimers()
    await Promise.resolve()
    const hasTree = spy.mock.calls.some(
      (c) => Array.isArray(c[0]?.queryKey) && c[0]?.queryKey[0] === 'tree'
    )
    expect(hasTree).toBe(true)
  })

  it('impactedPaths invalidates minimal set of dirs', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => '.' })
    __emit('tree.changed', { dir: 'src', impactedPaths: ['src/a', 'src/a/b', 'src/c'] })
    vi.runAllTimers()
    const calls = spy.mock.calls.map((c) => c[0])
    // 按当前实现，impactedPaths 的父目录会被 calcMinimalDirs 折叠成最小集合，
    // 对于 ['src/a', 'src/a/b', 'src/c']，最小集合为 ['src']，同时事件携带的 dir='src' 也会被加入。
    // 因此至少应包含 ['tree','.', 'src'] 的失效。
    const hasSrc = calls.some(
      (arg: any) => JSON.stringify(arg?.queryKey) === JSON.stringify(['tree', '.', 'src'])
    )
    expect(hasSrc).toBe(true)
  })

  it('session.resync triggers coarse refresh', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    installTreeInvalidator(qc, { getCurrentRoot: () => '.', getCurrentDir: () => 'src' })
    __emit('session.resync', {})
    await Promise.resolve()
    const has = spy.mock.calls.some(
      (c) => JSON.stringify(c[0]?.queryKey) === JSON.stringify(['tree', '.', 'src'])
    )
    expect(has).toBe(true)
  })
})
