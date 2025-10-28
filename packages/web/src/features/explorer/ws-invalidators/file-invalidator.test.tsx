import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { Subject } from 'rxjs'

vi.useFakeTimers()
vi.mock('@/lib/ws/singleton')

import { installFileInvalidator } from './file-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { ws as mockedWs, __emit } from '@/lib/ws/singleton'

describe('file-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('dedups file.changed and invalidates file + containing dir tree', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const cleanup = installFileInvalidator(qc, { getCurrentRoot: () => '.' })
    // emit digest event then a quick duplicate without digest
    __emit('file.changed', { path: 'src/a.txt', digest: 'abc' })
    __emit('file.changed', { path: 'src/a.txt' })
    vi.runAllTimers()

    const calls = spy.mock.calls.map((c) => c[0])
    const hasFile = calls.some((arg: any) => typeof arg?.predicate === 'function')
    const hasTree = calls.some(
      (arg: any) => JSON.stringify(arg?.queryKey) === JSON.stringify(['tree', '.', 'src'])
    )
    expect(hasFile).toBe(true)
    expect(hasTree).toBe(true)
    cleanup()
  })
})
