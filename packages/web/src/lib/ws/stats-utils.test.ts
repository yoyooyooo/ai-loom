import { describe, it, expect } from 'vitest'
import { computeDelta, updateSeries } from './stats-utils'

describe('stats-utils', () => {
  it('computeDelta returns non-negative deltas', () => {
    const prev = { treeChangedBatches: 10, droppedRingLowpri: 3 }
    const curr = { treeChangedBatches: 14, droppedRingLowpri: 1 }
    expect(computeDelta(prev as any, curr as any, 'treeChangedBatches')).toBe(4)
    expect(computeDelta(prev as any, curr as any, 'droppedRingLowpri')).toBe(0)
  })
  it('updateSeries caps size and appends values', () => {
    const s1 = updateSeries([], 1, 3)
    const s2 = updateSeries(s1, 2, 3)
    const s3 = updateSeries(s2, 3, 3)
    const s4 = updateSeries(s3, 4, 3)
    expect(s4).toEqual([2,3,4])
  })
})

