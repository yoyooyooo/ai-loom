import { describe, it, expect } from 'vitest'
import {
  mergeRanges,
  parseExploreActions,
  buildExploreText
} from '@/features/codex-chat/utils/explore-utils'

describe('mergeRanges', () => {
  it('merges overlapping and adjacent ranges', () => {
    let rs: Array<[number, number]> = []
    rs = mergeRanges(rs, [1, 200])
    expect(rs).toEqual([[1, 200]])
    rs = mergeRanges(rs, [200, 400])
    expect(rs).toEqual([[1, 400]])
    rs = mergeRanges(rs, [600, 800])
    expect(rs).toEqual([
      [1, 400],
      [600, 800]
    ])
    rs = mergeRanges(rs, [390, 610])
    expect(rs).toEqual([[1, 800]])
    rs = mergeRanges(rs, [1000, 950]) // reversed order
    expect(rs).toEqual([
      [1, 800],
      [950, 1000]
    ])
  })
})

describe('parseExploreActions', () => {
  it('parses sed -n chunked reads', () => {
    const acts = parseExploreActions(
      ['bash', '-lc', "sed -n '1,200p' src/a.ts && sed -n '200,400p' src/a.ts"],
      '/root'
    )
    expect(acts.filter((a) => a.kind === 'read')).toHaveLength(2)
    const paths = acts.filter((a) => a.kind === 'read').map((a: any) => a.path)
    expect(paths.every((p) => p.startsWith('/root/'))).toBe(true)
  })

  it('parses sed with quoted paths and normalizes .. / . segments', () => {
    const acts = parseExploreActions(
      ['bash', '-lc', 'sed -n "1,200p" ./a/b/../c.ts && sed -n \'200,400p\' a/./c.ts'],
      '/r'
    )
    const reads = acts.filter((a) => a.kind === 'read') as any[]
    expect(reads).toHaveLength(2)
    expect(reads[0].path).toBe(reads[1].path)
    expect(reads[0].path).toMatch(/^\/r\//)
  })

  it('parses nl -ba <file> | sed -n pipeline', () => {
    const acts = parseExploreActions(['bash', '-lc', "nl -ba src/ws.ts | sed -n '1,140p'"], '/home')
    const read = acts.find((a) => a.kind === 'read') as any
    expect(read).toBeTruthy()
    expect(read.path).toBe('/home/src/ws.ts')
    expect(read.start).toBe(1)
    expect(read.end).toBe(140)
  })

  it('parses ls and rg --files as list', () => {
    const acts = parseExploreActions(['bash', '-lc', 'ls -la packages && rg --files src'], '/w')
    expect(acts.filter((a) => a.kind === 'list')).toHaveLength(2)
  })

  it('parses bare ls as list targeting cwd', () => {
    const acts = parseExploreActions(['bash', '-lc', 'ls'], '/work')
    const lists = acts.filter((a) => a.kind === 'list') as any[]
    expect(lists.length).toBe(1)
    expect(lists[0].label).toBe('List ls')
    expect(lists[0].target).toBe('/work')
  })

  it('parses rg -n search scope', () => {
    const acts = parseExploreActions(['bash', '-lc', 'rg -n "todo" packages'], '/home')
    expect(acts.some((a) => a.kind === 'search')).toBe(true)
  })

  it('parses find as list (files and dirs), including pipes and || true', () => {
    const acts1 = parseExploreActions(
      ['bash', '-lc', "find packages -maxdepth 2 -type f -print | sed 's,^,FILE: ,'"],
      '/w'
    )
    expect(acts1.filter((a) => a.kind === 'list' && (a as any).label === 'List find')).toHaveLength(
      1
    )

    const acts2 = parseExploreActions(
      ['bash', '-lc', 'find packages -maxdepth 2 -type d -print'],
      '/w'
    )
    expect(acts2.filter((a) => a.kind === 'list' && (a as any).label === 'List find')).toHaveLength(
      1
    )

    const acts3 = parseExploreActions(
      ['bash', '-lc', 'find . -maxdepth 1 -type f -print || true'],
      '/w'
    )
    // 目标为 '.' 会被规整为 undefined，但仍视为 List
    const lists3 = acts3.filter((a) => a.kind === 'list') as any[]
    expect(lists3.length).toBe(1)
    expect(lists3[0].label).toBe('List find')
  })
})

describe('buildExploreText', () => {
  it('renders lists then reads (basenames, relative targets) and shows counts in header', () => {
    const reads: Record<string, Array<[number, number]>> = {
      '/w/a/file.ts': [
        [10, 20],
        [30, 40]
      ],
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
      'Search::/root/app::plan|todo': {
        label: 'Search',
        target: '/root/app',
        query: 'plan|todo',
        count: 1
      }
    }
    const text = buildExploreText(reads, lists)
    expect(text).toContain('Search plan|todo in app')
  })

  it('parses head -n as read(1..N)', () => {
    const acts = parseExploreActions(['bash', '-lc', 'head -n 120 src/x.ts'], '/home')
    const read = acts.find((a) => a.kind === 'read') as any
    expect(read).toBeTruthy()
    expect(read.start).toBe(1)
    expect(read.end).toBe(120)
  })

  it('parses cat <file> as read(full), hides line range', () => {
    const acts = parseExploreActions(['bash', '-lc', 'cat packages/web/package.json'], '/w')
    const reads = acts.filter((a) => a.kind === 'read') as any[]
    expect(reads.length).toBeGreaterThanOrEqual(1)
    expect(reads[0].path).toBe('/w/packages/web/package.json')
    // end=0 sentinel ensures UI hides lines
    expect(reads[0].end).toBe(0)
  })

  it('cat with write redirection is ignored as read', () => {
    const acts = parseExploreActions(['bash', '-lc', 'cat > out.txt'], '/w')
    expect(acts.some((a) => a.kind === 'read')).toBe(false)
  })

  it('rg flags (ci/word/type/glob/hidden) are parsed into action.flags', () => {
    const acts = parseExploreActions(
      ['bash', '-lc', 'rg -n -i -w -t ts -g "*.ts" --hidden "foo" src'],
      '/home'
    ) as any[]
    const s = acts.find((a) => a.kind === 'search')
    expect(s).toBeTruthy()
    expect(s.flags.ci).toBe(true)
    expect(s.flags.word).toBe(true)
    expect(s.flags.type).toBe('ts')
    expect(s.flags.glob).toBe('*.ts')
    expect(s.flags.hidden).toBe(true)
  })

  it('grep flags (ci/word) are parsed into action.flags', () => {
    const acts = parseExploreActions(['bash', '-lc', 'grep -niw "bar" src'], '/w') as any[]
    const s = acts.find((a) => a.kind === 'search')
    expect(s.flags.ci).toBe(true)
    expect(s.flags.word).toBe(true)
  })

  it('fd flags (type/hidden) are parsed into action.flags', () => {
    const acts = parseExploreActions(['bash', '-lc', 'fd -t f --hidden foo src'], '/w') as any[]
    const s = acts.find((a) => a.kind === 'search')
    expect(s.flags.type).toBe('f')
    expect(s.flags.hidden).toBe(true)
  })

  it('find without -name becomes list with depth/type flags', () => {
    const acts = parseExploreActions(
      ['bash', '-lc', 'find packages -maxdepth 2 -type f'],
      '/w'
    ) as any[]
    const l = acts.find((a) => a.kind === 'list')
    expect(l.flags.depth).toBe(2)
    expect(l.flags.type).toBe('f')
  })

  it('rg -n -o ".." | sed … → 正确解析查询与仅一个 search 动作', () => {
    const cmd = [
      'bash',
      '-lc',
      'rg -n -o "get/figmaToken" "/Users/y/.vscode/extensions/kombai.kombai-1.4.207/bundle.js" | sed -n "1,60p"'
    ]
    const acts = parseExploreActions(cmd, '/') as any[]
    const searches = acts.filter((a) => a.kind === 'search')
    expect(searches.length).toBe(1)
    expect(searches[0].query).toBe('get/figmaToken')
    // 目标文件为命令中的 bundle.js
    expect((searches[0].target || '').endsWith('bundle.js')).toBe(true)
  })

  it('rg -n "..|..|.." $(fd …) -S → 忽略 $(…) 的内部命中，仅一个外层 search', () => {
    const cmd = [
      'bash',
      '-lc',
      'rg -n "struct NewConversationParams|enum ClientNotification|AddConversationListenerParams|NewConversationResponse" $(fd -a codex_app_server_protocol | head -n 1) -S'
    ]
    const acts = parseExploreActions(cmd, '/w') as any[]
    const searches = acts.filter((a) => a.kind === 'search')
    expect(searches.length).toBe(1)
    // 不能把 $(fd …) 当作目标路径
    expect((searches[0].target || '').startsWith('/$(')).toBe(false)
  })

  it('grep -n -o 不误判为查询 o', () => {
    const cmd = ['bash', '-lc', 'grep -n -o foo src/file.txt']
    const acts = parseExploreActions(cmd, '/w') as any[]
    const s = acts.find((a) => a.kind === 'search')
    // 非引号场景，query 应为 foo，而不是 o
    expect(s.query).toBe('foo')
  })
})
