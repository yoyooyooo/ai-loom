import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { Subject } from 'rxjs'

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

import { installAnnotationsInvalidator } from './annotations-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { ws as mockedWs } from '@/lib/ws/singleton'

describe('annotations-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('applies created/updated/deleted and verify.done', async () => {
    qc.setQueryData(['annotations'], [{ id: 'x1', filePath: 'f', comment: 'a' }])
    installAnnotationsInvalidator(qc)
    const created = (mockedWs as any).__get('annotations.created') as Subject<any>
    const updated = (mockedWs as any).__get('annotations.updated') as Subject<any>
    const deleted = (mockedWs as any).__get('annotations.deleted') as Subject<any>
    created.next({ annotation: { id: 'x2', filePath: 'f2', comment: 'b' } })
    updated.next({ annotation: { id: 'x1', filePath: 'f', comment: 'z' } })
    deleted.next({ id: 'x2' })
    await Promise.resolve()
    const list = qc.getQueryData(['annotations']) as any[]
    expect(list.find((a) => a.id === 'x1')?.comment).toBe('z')
    expect(list.find((a) => a.id === 'x2')).toBeUndefined()
  })
})

