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

import { installFileInvalidator } from './file-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { ws as mockedWs } from '@/lib/ws/singleton'

describe('file-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('dedups file.changed and invalidates file + containing dir tree', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries')
    const cleanup = installFileInvalidator(qc, { getCurrentRoot: () => '.' })
    const fileChanged = (mockedWs as any).__get('file.changed') as Subject<any>
    // emit digest event then a quick duplicate without digest
    fileChanged.next({ path: 'src/a.txt', digest: 'abc' })
    fileChanged.next({ path: 'src/a.txt' })
    vi.runAllTimers()

    const calls = spy.mock.calls.map((c) => c[0])
    const hasFile = calls.some((arg: any) => typeof arg?.predicate === 'function')
    const hasTree = calls.some((arg: any) => JSON.stringify(arg?.queryKey) === JSON.stringify(['tree', '.', 'src']))
    expect(hasFile).toBe(true)
    expect(hasTree).toBe(true)
    cleanup()
  })
})

