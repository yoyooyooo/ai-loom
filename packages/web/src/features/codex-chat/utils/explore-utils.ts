// 读取/列表/搜索 聚合的纯函数与解析逻辑

export type ExploreAction =
  | { kind: 'read'; path: string; start: number; end: number }
  | { kind: 'list'; label: string; target?: string }
  | { kind: 'search'; label: string; target?: string; query?: string }

// 合并区间（包含端点，相邻合并；输入无需预排序）
export function mergeRanges(
  existing: Array<[number, number]>,
  incoming: [number, number]
): Array<[number, number]> {
  const [a, b] = incoming
  const nr: [number, number] = a <= b ? [a, b] : [b, a]
  const src = existing.slice()
  src.push(nr)
  src.sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const r of src) {
    if (out.length === 0) {
      out.push([r[0], r[1]])
    } else {
      const last = out[out.length - 1]
      if (r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
      else out.push([r[0], r[1]])
    }
  }
  return out
}

// 构建展示文本（按路径排序；lists 先于 reads）
export type ExploreSnapshot = {
  base: string
  lists: Array<{ label: string; target?: string; count: number; displayTarget?: string; query?: string }>
  files: Array<{ path: string; name: string; ranges: Array<[number, number]> }>
  filesCount: number
  opsCount: number
}

export function buildExploreSnapshot(
  reads: Record<string, Array<[number, number]>>,
  lists: Record<string, { label: string; target?: string; count: number; query?: string }>
): ExploreSnapshot {
  const allTargets: string[] = []
  for (const k of Object.keys(lists)) {
    if (lists[k]?.target) allTargets.push(String(lists[k].target))
  }
  const readPaths = Object.keys(reads)
  allTargets.push(...readPaths)
  const base = lcpDir(allTargets)
  const rel = (p?: string) => (p ? toRelative(p, base) : undefined)

  const listsArr = Object.keys(lists).map((k) => {
    const it = lists[k]
    const displayTarget = rel(it.target)
    return { ...it, displayTarget }
  })
  const filesArr = readPaths
    .map((p) => ({ path: p, name: basename(toRelative(p, base)), ranges: reads[p] || [] }))

  return {
    base,
    lists: listsArr,
    files: filesArr,
    filesCount: filesArr.length,
    opsCount: listsArr.length,
  }
}

export function snapshotToText(s: ExploreSnapshot): string {
  const head = s.opsCount || s.filesCount ? `[explored] files: ${s.filesCount}, ops: ${s.opsCount}` : '[explored]'
  const lines: string[] = [head]
  for (const it of s.lists) {
    const tail = it.count > 1 ? ` (x${it.count})` : ''
    if (it.label.toLowerCase().startsWith('search') && it.query) {
      const where = it.displayTarget ? ` in ${it.displayTarget}` : ''
      lines.push(`Search ${it.query}${where}${tail}`)
    } else {
      lines.push(`${it.label}${it.displayTarget ? ' ' + it.displayTarget : ''}${tail}`)
    }
  }
  if (s.files.length > 0) {
    const seen = new Set<string>()
    const names: string[] = []
    for (const f of s.files) {
      const n = String(f.name).replace(/\r?\n/g, ' ')
      if (!seen.has(n)) { seen.add(n); names.push(n) }
    }
    // 与 TUI 文案保持一致：以 "Read " 作为前缀
    lines.push('Read ' + names.join(', '))
  }
  return lines.join('\n') + '\n'
}

// 兼容旧用法：直接从 reads/lists 构建文本
export function buildExploreText(
  reads: Record<string, Array<[number, number]>>,
  lists: Record<string, { label: string; target?: string; count: number; query?: string }>
): string {
  return snapshotToText(buildExploreSnapshot(reads, lists))
}

// 解析 exec 命令为读取/列出/搜索动作（启发式；未命中返回空）
export function parseExploreActions(command: string[], cwd?: string): ExploreAction[] {
  try {
    const s = (command || []).join(' ')
    const acts: ExploreAction[] = []
    const joinNormalize = (base: string | undefined, p: string) => {
      const abs = /^\//.test(p) ? p : (base ? base.replace(/\/$/, '') + '/' + p : p)
      const parts = abs.split('/')
      const out: string[] = []
      for (const seg of parts) {
        if (!seg || seg === '.') continue
        if (seg === '..') { if (out.length > 0) out.pop(); continue }
        out.push(seg)
      }
      return '/' + out.join('/')
    }
    const normPath = (p: string) => joinNormalize(cwd, String(p))
    // sed -n 'A,Bp' <file>
    // sed 带引号的路径：sed -n 'A,Bp' "path with space" / 'path with space'
    const reSedQuoted = /sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+(['"])(.+?)\3/g
    let mq: RegExpExecArray | null
    while ((mq = reSedQuoted.exec(s))) {
      const start = parseInt(mq[1], 10)
      const end = parseInt(mq[2], 10)
      const file = normPath(mq[4])
      acts.push({ kind: 'read', path: file, start, end })
    }
    // sed 未带引号的路径
    const reSed = /sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s+([^\s'";&]+)/g
    let m: RegExpExecArray | null
    while ((m = reSed.exec(s))) {
      const start = parseInt(m[1], 10)
      const end = parseInt(m[2], 10)
      const file = normPath(m[3])
      acts.push({ kind: 'read', path: file, start, end })
    }
    // sed -n 'A,Bp' < file  （输入重定向）
    const reSedRedirect = /sed\s+-n\s+['"]?(\d+),(\d+)p['"]?\s*<\s*(['"]?)(.+?)\3/g
    while ((m = reSedRedirect.exec(s))) {
      const start = parseInt(m[1], 10)
      const end = parseInt(m[2], 10)
      const file = normPath(m[4])
      acts.push({ kind: 'read', path: file, start, end })
    }
    // nl -ba <file> | sed -n 'A,Bp'   （管道形式）
    const reNlSed = /nl\s+-ba\s+(['"]?)(.+?)\1\s*\|\s*sed\s+-n\s+['"]?(\d+),(\d+)p['"]?/g
    while ((m = reNlSed.exec(s))) {
      const start = parseInt(m[3], 10)
      const end = parseInt(m[4], 10)
      const file = normPath(m[2])
      acts.push({ kind: 'read', path: file, start, end })
    }
    // ls -la/-R <dir>
    const reLs = /\bls\s+(-[A-Za-z]+)?\s*([^\s'";&]+)?/g
    while ((m = reLs.exec(s))) {
      let target = m[2] ? normPath(m[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'list', label: 'List ls', target })
    }
    // rg --files [dir]
    const reRgFiles = /\brg\s+--files(?:\s+([^\s'";&]+))?/g
    while ((m = reRgFiles.exec(s))) {
      let target = m[1] ? normPath(m[1]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'list', label: 'List rg --files', target })
    }
    // rg search: quoted/unquoted pattern, optional scope; tolerate extra flags
    const reRgQ = /\brg\b[^|;]*?-n[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s([^\s'";&|]+))?/g
    let mrq: RegExpExecArray | null
    while ((mrq = reRgQ.exec(s))) {
      const query = mrq[1]
      let target = mrq[2] ? normPath(mrq[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    const reRgNQ = /\brg\b[^|;]*?-n[^|;]*?([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mrn: RegExpExecArray | null
    while ((mrn = reRgNQ.exec(s))) {
      const query = mrn[1]
      if (!query) continue
      let target = mrn[2] ? normPath(mrn[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    // grep search
    const reGrepQ = /\bgrep\b[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s([^\s'";&|]+))?/g
    let mgq: RegExpExecArray | null
    while ((mgq = reGrepQ.exec(s))) {
      const query = mgq[1]
      let target = mgq[2] ? normPath(mgq[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    const reGrepNQ = /\bgrep\b[^|;]*?([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mgn: RegExpExecArray | null
    while ((mgn = reGrepNQ.exec(s))) {
      const query = mgn[1]
      if (!query) continue
      let target = mgn[2] ? normPath(mgn[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    // fd search
    const reFdQ = /\bfd\b[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s([^\s'";&|]+))?/g
    let mfdq: RegExpExecArray | null
    while ((mfdq = reFdQ.exec(s))) {
      const query = mfdq[1]
      let target = mfdq[2] ? normPath(mfdq[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    const reFdNQ = /\bfd\b[^|;]*?([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mfdn: RegExpExecArray | null
    while ((mfdn = reFdNQ.exec(s))) {
      const query = mfdn[1]
      if (!query) continue
      let target = mfdn[2] ? normPath(mfdn[2]) : (cwd ? normPath(cwd) : undefined)
      if (target && (target === '{}' || target === '.' || target === './')) target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    // find with -name/-iname → Search(query, path)
    const reFindSearch = /\bfind\b\s+(?:(['"])(.+?)\1|([^\s'";&|]+))[^|;]*?-(?:i?name)\s+(?:['"]([^'"]+)['"]|([^\s'";&|]+))/g
    let mfs: RegExpExecArray | null
    while ((mfs = reFindSearch.exec(s))) {
      const raw = mfs[2] || mfs[3]
      const query = mfs[4] || mfs[5]
      let target = raw ? normPath(raw) : undefined
      if (target && (target === '{}' || target === '.' || target === './')) target = undefined
      acts.push({ kind: 'search', label: 'Search', target, query })
    }
    // find <dir> ... -type f|d （可能带管道或 || true）→ 视为 List
    // 仅提取第一个参数作为 target
    const reFind = /\bfind\s+(?:(['\"])(.+?)\1|([^\s'\";&|]+))[^|;]*?-type\s+(f|d)\b/g
    let mf: RegExpExecArray | null
    while ((mf = reFind.exec(s))) {
      const raw = mf[2] || mf[3]
      let target = raw ? normPath(raw) : undefined
      if (target && (target === '{}' || target === '.' || target === './')) target = undefined
      acts.push({ kind: 'list', label: 'List find', target })
    }
    // head -n N <file> → 1..N
    const reHead = /\bhead\s+-n\s+(\d+)\s+([^\s'";&]+)/g
    while ((m = reHead.exec(s))) {
      const n = parseInt(m[1], 10)
      const file = normPath(m[2])
      acts.push({ kind: 'read', path: file, start: 1, end: n })
    }
    return acts
  } catch {
    return []
  }
}

function basename(p: string): string {
  try {
    const s = p.replace(/\/$/, '')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(idx + 1) : s
  } catch { return p }
}

function toRelative(p: string, base: string): string {
  try {
    if (!base) return p
    return p.startsWith(base) ? p.slice(base.length) : p
  } catch { return p }
}

function lcpDir(paths: string[]): string {
  if (!paths || paths.length === 0) return ''
  const arr = paths.filter(Boolean)
  if (arr.length === 0) return ''
  let prefix = arr[0]
  for (let i = 1; i < arr.length; i++) {
    const s = arr[i]
    let j = 0
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++
    prefix = prefix.slice(0, j)
    if (!prefix) break
  }
  const cut = prefix.lastIndexOf('/')
  return cut > 0 ? prefix.slice(0, cut + 1) : ''
}
