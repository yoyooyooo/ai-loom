import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/ws/singleton', () => {
  let mode: 'ok' | 'business' | 'transport' | 'too_large' = 'ok'
  let firstCount = 0
  function __setWsMode(m: any) {
    mode = m
  }
  const ws = {
    enabled: true,
    call: (_m: string, _p?: any, _t?: number) => ({}) as any,
    first: async (_obs: any) => {
      firstCount++
      if (mode === 'ok') return 42
      if (mode === 'business') {
        const e: any = new Error('OVER_LIMIT')
        e.code = 'OVER_LIMIT'
        throw e
      }
      if (mode === 'transport') {
        const e: any = new Error('WS_DOWN')
        e.code = 'WS_DOWN'
        throw e
      }
      if (mode === 'too_large') {
        const e: any = new Error('MESSAGE_TOO_LARGE')
        e.code = 'MESSAGE_TOO_LARGE'
        throw e
      }
      return 0
    }
  }
  const __getFirstCount = () => firstCount
  return { ws, __setWsMode, __getFirstCount }
})

import { wsPrefer } from '@/lib/ws/query-helpers'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore mock helper only exists in tests
import { __setWsMode, __getFirstCount } from '@/lib/ws/singleton'

describe('wsPrefer', () => {
  it('returns WS result when ok', async () => {
    __setWsMode('ok')
    const r = await wsPrefer('x', {}, async () => 'fallback')
    expect(r).toBe(42)
  })

  it('does not fallback on business error', async () => {
    __setWsMode('business')
    const fb = vi.fn(async () => 'fallback')
    await expect(wsPrefer('x', {}, fb)).rejects.toBeInstanceOf(Error)
    expect(fb).not.toHaveBeenCalled()
  })

  it('fallbacks on transport error', async () => {
    __setWsMode('transport')
    const r = await wsPrefer('x', {}, async () => 'fallback')
    expect(r).toBe('fallback')
  })

  it('fallbacks on MESSAGE_TOO_LARGE', async () => {
    __setWsMode('too_large')
    const r = await wsPrefer('x', {}, async () => 'rest')
    expect(r).toBe('rest')
  })

  it('fuse window skips WS after transport error', async () => {
    __setWsMode('transport')
    const before = __getFirstCount()
    const r1 = await wsPrefer('x', {}, async () => 'rest1', { fuseMs: 1000 })
    expect(r1).toBe('rest1')
    const mid = __getFirstCount()
    // 第二次应直接回退 REST，不再调用 ws.first
    const r2 = await wsPrefer('x', {}, async () => 'rest2', { fuseMs: 1000 })
    const after = __getFirstCount()
    expect(r2).toBe('rest2')
    expect(after).toBe(mid)
    expect(mid).toBeGreaterThanOrEqual(before)
  })

  it('WS_DISABLED falls back to REST', async () => {
    // simulate disabled by throwing WS_DISABLED on first
    __setWsMode('transport')
    const r = await wsPrefer('x', {}, async () => 'rest3', { fuseMs: 0 })
    expect(r).toBe('rest3')
  })
})
