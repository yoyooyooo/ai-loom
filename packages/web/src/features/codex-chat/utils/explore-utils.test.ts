import { describe, it, expect } from 'vitest'
import { mergeRanges, parseExploreActions, buildExploreText } from './explore-utils'

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges', () => {
    let rs: Array<[number, number]> = []
    rs = mergeRanges(rs, [1, 200])
    expect(rs).toEqual([[1, 200]])
    rs = mergeRanges(rs, [200, 400])
    expect(rs).toEqual([[1, 400]])
    rs = mergeRanges(rs, [600, 800])
    expect(rs).toEqual([[1, 400], [600, 800]])
    rs = mergeRanges(rs, [390, 610])
    expect(rs).toEqual([[1, 800]])
    rs = mergeRanges(rs, [1000, 950]) // reversed order
    expect(rs).toEqual([[1, 800], [950, 1000]])
  })
})

describe('parseExploreActions', () => {
  it('parses sed -n chunked reads', () => {
    const acts = parseExploreActions([
      'bash',
      '-lc',
      "sed -n '1,200p' src/a.ts && sed -n '200,400p' src/a.ts"
    ], '/root')
    expect(acts.filter(a => a.kind === 'read')).toHaveLength(2)
    const paths = acts.filter(a => a.kind === 'read').map((a: any) => a.path)
    expect(paths.every(p => p.startsWith('/root/'))).toBe(true)
  })

  it('parses sed with quoted paths and normalizes .. / . segments', () => {
    const acts = parseExploreActions([
      'bash','-lc',
      "sed -n \"1,200p\" ./a/b/../c.ts && sed -n '200,400p' a/./c.ts"
    ], '/r')
    const reads = acts.filter(a => a.kind === 'read') as any[]
    expect(reads).toHaveLength(2)
    expect(reads[0].path).toBe(reads[1].path)
    expect(reads[0].path).toMatch(/^\/r\//)
  })

  it('parses nl -ba <file> | sed -n pipeline', () => {
    const acts = parseExploreActions([
      'bash','-lc',
      "nl -ba src/ws.ts | sed -n '1,140p'"
    ], '/home')
    const read = acts.find(a => a.kind === 'read') as any
    expect(read).toBeTruthy()
    expect(read.path).toBe('/home/src/ws.ts')
    expect(read.start).toBe(1)
    expect(read.end).toBe(140)
  })

  it('parses ls and rg --files as list', () => {
    const acts = parseExploreActions(['bash','-lc','ls -la packages && rg --files src'], '/w')
    expect(acts.filter(a => a.kind === 'list')).toHaveLength(2)
  })

  it('parses rg -n search scope', () => {
    const acts = parseExploreActions(['bash','-lc','rg -n "todo" packages'], '/home')
    expect(acts.some(a => a.kind === 'search')).toBe(true)
  })

  it('parses find as list (files and dirs), including pipes and || true', () => {
    const acts1 = parseExploreActions([
      'bash','-lc',
      "find packages -maxdepth 2 -type f -print | sed 's,^,FILE: ,'"
    ], '/w')
    expect(acts1.filter(a => a.kind === 'list' && (a as any).label === 'List find')).toHaveLength(1)

    const acts2 = parseExploreActions([
      'bash','-lc',
      'find packages -maxdepth 2 -type d -print'
    ], '/w')
    expect(acts2.filter(a => a.kind === 'list' && (a as any).label === 'List find')).toHaveLength(1)

    const acts3 = parseExploreActions([
      'bash','-lc',
      'find . -maxdepth 1 -type f -print || true'
    ], '/w')
    // 目标为 '.' 会被规整为 undefined，但仍视为 List
    const lists3 = acts3.filter(a => a.kind === 'list') as any[]
    expect(lists3.length).toBe(1)
    expect(lists3[0].label).toBe('List find')
  })
})

describe('buildExploreText', () => {
  it('renders lists then reads (basenames, relative targets) and shows counts in header', () => {
    const reads: Record<string, Array<[number, number]>> = {
      '/w/a/file.ts': [[10, 20], [30, 40]],
      '/w/b/file.ts': [[1, 200]]
    }
    const lists: Record<string, any> = {
      'List ls::/w/src::': { label: 'List ls', target: '/w/src', count: 2 }
    }
    const text = buildExploreText(reads, lists)
    expect(text.startsWith('[explored] files: 2, ops: 1')).toBe(true)
    expect(text).toContain('List ls src (x2)')
    // files condensed with "Read " prefix
    expect(text).toMatch(/Read .*file\.ts/)
  })

  it('renders Search <query> in <target> when query is present', () => {
    const reads: Record<string, Array<[number, number]>> = {}
    const lists: Record<string, any> = {
      'Search::/root/app::plan|todo': { label: 'Search', target: '/root/app', query: 'plan|todo', count: 1 }
    }
    const text = buildExploreText(reads, lists)
    expect(text).toContain('Search plan|todo in app')
  })

  it('parses head -n as read(1..N)', () => {
    const acts = parseExploreActions(['bash','-lc','head -n 120 src/x.ts'], '/home')
    const read = acts.find(a => a.kind === 'read') as any
    expect(read).toBeTruthy()
    expect(read.start).toBe(1)
    expect(read.end).toBe(120)
  })
})
