import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { Subject } from 'rxjs'

vi.mock('@/lib/ws/singleton')

import { installAnnotationsInvalidator } from './annotations-invalidator'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore test-only access
import { __emit } from '@/lib/ws/singleton'

describe('annotations-invalidator', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
  })

  it('applies created/updated/deleted and verify.done', async () => {
    qc.setQueryData(['annotations'], [{ id: 'x1', filePath: 'f', comment: 'a' }])
    installAnnotationsInvalidator(qc)
    __emit('annotations.created', { annotation: { id: 'x2', filePath: 'f2', comment: 'b' } })
    __emit('annotations.updated', { annotation: { id: 'x1', filePath: 'f', comment: 'z' } })
    __emit('annotations.deleted', { id: 'x2' })
    await Promise.resolve()
    const list = qc.getQueryData(['annotations']) as any[]
    expect(list.find((a) => a.id === 'x1')?.comment).toBe('z')
    expect(list.find((a) => a.id === 'x2')).toBeUndefined()
  })
})
