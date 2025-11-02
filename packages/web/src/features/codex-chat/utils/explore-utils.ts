// 读取/列表/搜索 聚合的纯函数与解析逻辑

export type ExploreAction =
  | { kind: 'read'; path: string; start: number; end: number }
  | {
      kind: 'list'
      label: string
      target?: string
      flags?: { depth?: number; type?: string; recursive?: boolean }
    }
  | {
      kind: 'search'
      label: string
      target?: string
      query?: string
      flags?: { ci?: boolean; word?: boolean; type?: string; glob?: string; hidden?: boolean }
    }

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
  lists: Array<{
    label: string
    target?: string
    count: number
    displayTarget?: string
    query?: string
  }>
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
  const filesArr = readPaths.map((p) => ({
    path: p,
    name: basename(toRelative(p, base)),
    ranges: reads[p] || []
  }))

  return {
    base,
    lists: listsArr,
    files: filesArr,
    filesCount: filesArr.length,
    opsCount: listsArr.length
  }
}

export function snapshotToText(s: ExploreSnapshot): string {
  const head =
    s.opsCount || s.filesCount
      ? `[explored] files: ${s.filesCount}, ops: ${s.opsCount}`
      : '[explored]'
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
      if (!seen.has(n)) {
        seen.add(n)
        names.push(n)
      }
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
    // 识别命令替换 $(...) 的区间，便于在后续解析中跳过其中的模式命中（例如 rg 外层 + fd 内层）
    const substRanges: Array<[number, number]> = []
    try {
      for (let i = 0; i < s.length - 1; i++) {
        if (s[i] === '$' && s[i + 1] === '(') {
          let depth = 1
          let j = i + 2
          while (j < s.length && depth > 0) {
            const ch = s[j]
            if (ch === '(') depth += 1
            else if (ch === ')') depth -= 1
            j += 1
          }
          const end = Math.min(j - 1, s.length - 1)
          substRanges.push([i, end])
          i = end
        }
      }
    } catch {}
    const inSubst = (idx: number) => substRanges.some(([a, b]) => idx >= a && idx <= b)
    const joinNormalize = (base: string | undefined, p: string) => {
      const abs = /^\//.test(p) ? p : base ? base.replace(/\/$/, '') + '/' + p : p
      const parts = abs.split('/')
      const out: string[] = []
      for (const seg of parts) {
        if (!seg || seg === '.') continue
        if (seg === '..') {
          if (out.length > 0) out.pop()
          continue
        }
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
    // ls / ls -la <dir>
    const reLs = /\bls(?:\s+(-[A-Za-z\-]+))?\s*([^\s'";&]+)?/g
    while ((m = reLs.exec(s))) {
      let target = m[2] ? normPath(m[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'list', label: 'List ls', target })
    }
    // rg --files [dir]
    const reRgFiles = /\brg\s+--files(?:\s+([^\s'";&]+))?/g
    while ((m = reRgFiles.exec(s))) {
      let target = m[1] ? normPath(m[1]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'list', label: 'List rg --files', target })
    }
    // rg search: quoted/unquoted pattern, optional scope; tolerate extra flags
    // 支持目标参数为带引号或不带引号两种形式
    const reRgQ =
      /\brg\b[^|;]*?-n[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s(?:['"]([^'"]+)['"]|([^\s'";&|]+)))?/g
    let mrq: RegExpExecArray | null
    while ((mrq = reRgQ.exec(s))) {
      // 忽略子命令 $(...) 内的匹配
      if (inSubst(mrq.index)) continue
      const query = mrq[1]
      const rawT = mrq[2] || mrq[3]
      let target = rawT && !/^\$\(/.test(rawT) ? normPath(rawT) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mrq.index,
        s.indexOf('|', mrq.index) > -1 ? s.indexOf('|', mrq.index) : s.length
      )
      const flags = extractRgFlags(seg)
      acts.push({ kind: 'search', label: 'Search', target, query, flags })
    }
    // 非引号形式：确保在空白边界后提取查询，避免将 -o 等短参的字母误判为查询
    const reRgNQ = /\brg\b[^|;]*?-n[^|;]*?\s+([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mrn: RegExpExecArray | null
    while ((mrn = reRgNQ.exec(s))) {
      if (inSubst(mrn.index)) continue
      const query = mrn[1]
      if (!query) continue
      let target =
        mrn[2] && !/^\$\(/.test(mrn[2]) ? normPath(mrn[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mrn.index,
        s.indexOf('|', mrn.index) > -1 ? s.indexOf('|', mrn.index) : s.length
      )
      // 若该段内已出现引号，说明应由 reRgQ 处理，跳过以避免重复及误判
      if (/["']/.test(seg)) continue
      const flags = extractRgFlags(seg)
      acts.push({ kind: 'search', label: 'Search', target, query, flags })
    }
    // grep search
    const reGrepQ = /\bgrep\b[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s([^\s'";&|]+))?/g
    let mgq: RegExpExecArray | null
    while ((mgq = reGrepQ.exec(s))) {
      if (inSubst(mgq.index)) continue
      const query = mgq[1]
      let target =
        mgq[2] && !/^\$\(/.test(mgq[2]) ? normPath(mgq[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mgq.index,
        s.indexOf('|', mgq.index) > -1 ? s.indexOf('|', mgq.index) : s.length
      )
      const flags = extractGrepFlags(seg)
      acts.push({ kind: 'search', label: 'Search', target, query, flags })
    }
    // grep 非引号形式同样要求空白边界，避免 -o 等被误判
    const reGrepNQ = /\bgrep\b[^|;]*?\s+([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mgn: RegExpExecArray | null
    while ((mgn = reGrepNQ.exec(s))) {
      if (inSubst(mgn.index)) continue
      const query = mgn[1]
      if (!query) continue
      let target =
        mgn[2] && !/^\$\(/.test(mgn[2]) ? normPath(mgn[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mgn.index,
        s.indexOf('|', mgn.index) > -1 ? s.indexOf('|', mgn.index) : s.length
      )
      const flags = extractGrepFlags(seg)
      acts.push({ kind: 'search', label: 'Search', target, query, flags })
    }
    // fd search
    const reFdQ = /\bfd\b[^|;]*?['"]([^'"]+)['"][^|;]*?(?:\s([^\s'";&|]+))?/g
    let mfdq: RegExpExecArray | null
    while ((mfdq = reFdQ.exec(s))) {
      if (inSubst(mfdq.index)) continue
      const query = mfdq[1]
      let target = mfdq[2] ? normPath(mfdq[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mfdq.index,
        s.indexOf('|', mfdq.index) > -1 ? s.indexOf('|', mfdq.index) : s.length
      )
      const f = extractFdFlags(seg)
      acts.push({
        kind: 'search',
        label: 'Search',
        target,
        query,
        flags: { type: f.type, hidden: f.hidden }
      })
    }
    const reFdNQ = /\bfd\b[^|;]*?([^\s'";&|\-][^\s'";&|]*)[^|;]*?(?:\s([^\s'";&|]+))?/g
    let mfdn: RegExpExecArray | null
    while ((mfdn = reFdNQ.exec(s))) {
      if (inSubst(mfdn.index)) continue
      const query = mfdn[1]
      if (!query) continue
      let target = mfdn[2] ? normPath(mfdn[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      const seg = s.slice(
        mfdn.index,
        s.indexOf('|', mfdn.index) > -1 ? s.indexOf('|', mfdn.index) : s.length
      )
      const f = extractFdFlags(seg)
      acts.push({
        kind: 'search',
        label: 'Search',
        target,
        query,
        flags: { type: f.type, hidden: f.hidden }
      })
    }
    // find with -name/-iname → Search(query, path)
    const reFindSearch = /\bfind\b\s+(?:(['"])(.+?)\1|([^\s'";&|]+))([^|;]*)/g
    let mfs: RegExpExecArray | null
    while ((mfs = reFindSearch.exec(s))) {
      if (inSubst(mfs.index)) continue
      const raw = mfs[2] || mfs[3]
      const tail = mfs[4] || ''
      const mName = tail.match(/-(?:i?name)\s+(?:['"]([^'"]+)['"]|([^\s'";&|]+))/)
      const query = mName ? mName[1] || mName[2] : undefined
      const mDepth = tail.match(/-maxdepth\s+(\d+)/)
      const mType = tail.match(/-type\s+([fd])/)
      let target = raw ? normPath(raw) : undefined
      if (target && (target === '{}' || target === '.' || target === './')) target = undefined
      if (query) acts.push({ kind: 'search', label: 'Search', target, query })
      else
        acts.push({
          kind: 'list',
          label: 'List find',
          target,
          flags: {
            depth: mDepth ? parseInt(mDepth[1], 10) : undefined,
            type: mType ? mType[1] : undefined
          }
        })
    }
    // tree -L N <dir> → 视为 List（depth=N）
    const reTree = /\btree\b[^|;]*?-L\s+(\d+)\s+([^\s'";&]+)/g
    let mt: RegExpExecArray | null
    while ((mt = reTree.exec(s))) {
      let target = mt[2] ? normPath(mt[2]) : cwd ? normPath(cwd) : undefined
      if (target && (target === '{}' || target === '.' || target === './'))
        target = cwd ? normPath(cwd) : undefined
      acts.push({ kind: 'list', label: 'List tree', target, flags: { depth: parseInt(mt[1], 10) } })
    }
    // head -n N <file> → 1..N
    const reHead = /\bhead\s+-n\s+(\d+)\s+([^\s'";&]+)/g
    while ((m = reHead.exec(s))) {
      const n = parseInt(m[1], 10)
      const file = normPath(m[2])
      acts.push({ kind: 'read', path: file, start: 1, end: n })
    }
    // cat <file> [file2 ...] → Read full file(s)（忽略带重定向写入用法，如 cat > out）
    const reCatSeg = /\bcat\b([^|;]+)/g
    let mcat: RegExpExecArray | null
    while ((mcat = reCatSeg.exec(s))) {
      const seg = mcat[1]
      if (/>/.test(seg) || />>/.test(seg) || /<</.test(seg)) continue
      const seen = new Set<string>()
      const rq = /(['\"])(.+?)\1/g
      let mq: RegExpExecArray | null
      while ((mq = rq.exec(seg))) {
        const p = normPath(mq[2])
        if (!seen.has(p)) {
          seen.add(p)
          acts.push({ kind: 'read', path: p, start: 1, end: 0 as any })
        }
      }
      const rnq = /(?:^|\s)([^\s'\"<>;&|]+)(?=\s|$)/g
      let mnq: RegExpExecArray | null
      while ((mnq = rnq.exec(seg))) {
        const tok = mnq[1]
        if (!tok || tok.startsWith('-')) continue
        if (tok === '.' && cwd) {
          const p = normPath(cwd)
          if (!seen.has(p)) {
            seen.add(p)
            acts.push({ kind: 'read', path: p, start: 1, end: 0 as any })
          }
          continue
        }
        if (tok === '>' || tok === '>>' || tok === '<<') continue
        const p = normPath(tok)
        if (!seen.has(p)) {
          seen.add(p)
          acts.push({ kind: 'read', path: p, start: 1, end: 0 as any })
        }
      }
    }
    // tail -n N <file> → last N
    const reTail = /\btail\s+-n\s+(\d+)\s+([^\s'";&]+)/g
    let mtl: RegExpExecArray | null
    while ((mtl = reTail.exec(s))) {
      const n = parseInt(mtl[1], 10)
      const file = normPath(mtl[2])
      ;(acts as any).push({ kind: 'read', path: file, start: 1, end: 0 as any, tail: n })
    }
    return acts
  } catch {
    return []
  }
}

function extractRgFlags(seg: string): {
  ci?: boolean
  word?: boolean
  type?: string
  glob?: string
  hidden?: boolean
} {
  const ci = /\s-(?:i|\-ignore-case)\b/.test(seg)
  const word = /\s-(?:w|\-word-regexp)\b/.test(seg)
  const hidden = /\s--hidden\b/.test(seg)
  const mType = seg.match(/\s-(?:t|\-type)\s+([^\s'";&|]+)/)
  const mGlob = seg.match(/\s-(?:g|\-glob)\s+(?:['"]([^'"]+)['"]|([^\s'";&|]+))/)
  return {
    ci,
    word,
    hidden,
    type: mType ? mType[1] : undefined,
    glob: mGlob ? mGlob[1] || mGlob[2] : undefined
  }
}

function extractGrepFlags(seg: string): { ci?: boolean; word?: boolean } {
  // support combined short flags like -niw
  const shorts = Array.from(seg.matchAll(/\s-([A-Za-z]+)/g))
    .map((m) => m[1])
    .join('')
  const ci = /\s-(?:i|\-ignore-case)\b/.test(seg) || /i/.test(shorts)
  const word = /\s-(?:w|\-word-regexp)\b/.test(seg) || /w/.test(shorts)
  return { ci, word }
}

function extractFdFlags(seg: string): { depth?: number; type?: string; hidden?: boolean } {
  const mDepth = seg.match(/\s-(?:d|\-max-depth)\s+(\d+)/)
  const mType = seg.match(/\s-(?:t|\-type)\s+([fd])/)
  const hidden = /\s--hidden\b/.test(seg)
  return {
    depth: mDepth ? parseInt(mDepth[1], 10) : undefined,
    type: mType ? mType[1] : undefined,
    hidden
  }
}

// 读取/列表/搜索 步骤标题与 meta 构建（纯函数，供 WS 实时与 Resume 共用）
// 注：read/list/search 的 Step 构建函数已迁移至 services/ws-step-builders.ts，便于集中维护

function basename(p: string): string {
  try {
    const s = p.replace(/\/$/, '')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(idx + 1) : s
  } catch {
    return p
  }
}

function toRelative(p: string, base: string): string {
  try {
    if (!base) return p
    return p.startsWith(base) ? p.slice(base.length) : p
  } catch {
    return p
  }
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
