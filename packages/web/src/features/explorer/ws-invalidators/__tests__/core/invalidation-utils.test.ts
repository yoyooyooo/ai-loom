import { describe, it, expect } from 'vitest'
import { calcMinimalDirs, dirname } from '../../invalidation-utils'

describe('invalidation-utils', () => {
  it('calcMinimalDirs merges parent/child correctly', () => {
    const res = calcMinimalDirs(['src', 'src/a', 'src/a/b', 'docs', 'docs', 'docs/guide'])
    expect(res).toEqual(['src', 'docs'])
  })
  it('dirname works', () => {
    expect(dirname('src/a.txt')).toBe('src')
    expect(dirname('file')).toBe('.')
    expect(dirname('/a')).toBe('/')
  })
})
