// 读取/列表/搜索 聚合的纯函数与解析逻辑

export type ExploreAction =
  | { kind: 'read'; path: string; start: number; end: number }
  | {
      kind: 'list'
      label: string
      target?: string
      targetDisplay?: string
      flags?: { depth?: number; type?: string; recursive?: boolean }
    }
  | {
      kind: 'search'
      label: string
      target?: string
      targetDisplay?: string
      query?: string
      flags?: { ci?: boolean; word?: boolean; type?: string; glob?: string; hidden?: boolean }
    }

type CommandSegment = {
  tokens: string[]
  text: string
  connectorBefore?: string
}

type ProcessContext = {
  cwd?: string
  initialCwd?: string
  pipelineInputPath?: string
}

type ProcessResult = {
  actions: ExploreAction[]
  nextCwd?: string
  pipelineOutputPath?: string
}

const LS_FLAGS_WITH_VALUES = [
  '-I',
  '-w',
  '--block-size',
  '--format',
  '--time-style',
  '--color',
  '--quoting-style'
]

const RG_FLAGS_WITH_VALUES = [
  '-e',
  '--regexp',
  '-g',
  '--glob',
  '-p',
  '--path',
  '--pre',
  '--pre-glob',
  '--colors',
  '--encoding',
  '--type',
  '-t',
  '--type-not',
  '-T',
  '--threads',
  '--sortr',
  '--sort-files',
  '--max-count',
  '-m'
]

const GREP_FLAGS_WITH_VALUES = ['-f', '--file', '-e', '--regexp', '--include', '--exclude']

const FD_FLAGS_WITH_VALUES = ['-t', '--type', '-e', '--extension', '-E', '--exclude', '--search-path']

const FIND_UNARY_OPERATORS = new Set(['-name', '-iname', '-path', '-regex'])

const SHORT_DISPLAY_IGNORE = new Set(['build', 'dist', 'node_modules', 'src'])

function stripWrappingQuotes(input: string | undefined): string | undefined {
  if (!input || input.length < 2) return input
  const first = input[0]
  const last = input[input.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return input.slice(1, -1)
  }
  return input
}

function shortDisplayPath(path?: string): string | undefined {
  if (!path) return undefined
  const normalized = path.replace(/\\/g, '/')
  const trimmed = normalized.replace(/\/+$/g, '')
  if (!trimmed) return path
  const segments = trimmed
    .split('/')
    .reverse()
    .filter((seg) => seg.length > 0 && !SHORT_DISPLAY_IGNORE.has(seg))
  if (segments.length > 0) return segments[0]
  return trimmed || path
}

function shlexSplit(input: string): string[] {
  const out: string[] = []
  let current = ''
  let i = 0
  let inSingle = false
  let inDouble = false

  const pushCurrent = () => {
    if (current.length > 0) {
      out.push(current)
      current = ''
    }
  }

  while (i < input.length) {
    const ch = input[i]

    if (inSingle) {
      if (ch === "'") {
        inSingle = false
      } else {
        current += ch
      }
      i += 1
      continue
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false
      } else if (ch === '\\' && i + 1 < input.length) {
        const next = input[i + 1]
        current += next
        i += 1
      } else {
        current += ch
      }
      i += 1
      continue
    }

    if (ch === "'") {
      inSingle = true
      i += 1
      continue
    }

    if (ch === '"') {
      inDouble = true
      i += 1
      continue
    }

    if (ch === '\\' && i + 1 < input.length) {
      current += input[i + 1]
      i += 2
      continue
    }

    if (ch === ' ' || ch === '\t' || ch === '\n') {
      pushCurrent()
      i += 1
      continue
    }

    if (ch === '|') {
      pushCurrent()
      if (input[i + 1] === '|') {
        out.push('||')
        i += 2
      } else {
        out.push('|')
        i += 1
      }
      continue
    }

    if (ch === '&') {
      pushCurrent()
      if (input[i + 1] === '&') {
        out.push('&&')
        i += 2
      } else {
        out.push('&')
        i += 1
      }
      continue
    }

    if (ch === ';') {
      pushCurrent()
      out.push(';')
      i += 1
      continue
    }

    current += ch
    i += 1
  }

  pushCurrent()
  return out
}

function normalizeCommandTokens(command: string[]): string[] {
  if (!Array.isArray(command) || command.length === 0) return []
  let tokens = command.slice()
  if (tokens.length === 1 && typeof tokens[0] === 'string') {
    const splitted = shlexSplit(tokens[0])
    if (splitted.length > 0) tokens = splitted
  }
  const [head, flag, ...rest] = tokens
  if (
    (head === 'bash' || head === 'zsh') &&
    (flag === '-c' || flag === '-lc') &&
    rest.length > 0
  ) {
    return shlexSplit(rest.join(' '))
  }
  if (
    tokens.length >= 2 &&
    (tokens[0] === 'yes' || tokens[0] === 'y' || tokens[0] === 'no' || tokens[0] === 'n') &&
    tokens[1] === '|'
  ) {
    return tokens.slice(2)
  }
  return tokens
}

function isConnector(token: string): boolean {
  return token === '&&' || token === '||' || token === '|' || token === ';'
}

function splitCommandSegments(tokens: string[]): CommandSegment[] {
  const segments: CommandSegment[] = []
  let current: string[] = []
  let connectorForNext: string | undefined

  const pushCurrent = () => {
    if (current.length === 0) return
    segments.push({
      tokens: current.slice(),
      text: current.join(' '),
      connectorBefore: connectorForNext
    })
    current = []
    connectorForNext = undefined
  }

  for (const tok of tokens) {
    if (isConnector(tok)) {
      pushCurrent()
      connectorForNext = tok
      continue
    }
    if (current.length === 0 && connectorForNext !== undefined && segments.length > 0) {
      // connectorForNext already applied to following command; keep as is
    }
    current.push(tok)
  }
  pushCurrent()
  return segments
}

function normalizeCwd(input?: string): string | undefined {
  if (!input) return undefined
  const s = input.replace(/\\/g, '/')
  return s.endsWith('/') ? s.slice(0, -1) : s
}

function joinNormalize(base: string | undefined, target: string): string | undefined {
  if (!target) return undefined
  if (target === '~' || target.startsWith('~/')) return target
  const normalizedTarget = target.replace(/\\/g, '/')
  if (normalizedTarget.startsWith('/')) return normalizeCwd(normalizedTarget) || '/'
  if (!base) return normalizeCwd('/' + normalizedTarget)
  const baseClean = normalizeCwd(base) || ''
  const parts = (baseClean + '/' + normalizedTarget).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

function resolvePath(
  cwd: string | undefined,
  initialCwd: string | undefined,
  value: string | undefined
): string | undefined {
  if (!value) return undefined
  const stripped = stripWrappingQuotes(value) || value
  const v = stripped
  if (value === '--') return undefined
  if (v.startsWith('$(')) return undefined
  if (v === '{}' || v === '.' || v === './') {
    return cwd || initialCwd
  }
  if (v === '..') {
    return joinNormalize(cwd || initialCwd, '..')
  }
  return joinNormalize(cwd || initialCwd, v) || v
}

function isPathish(value: string | undefined): boolean {
  if (!value) return false
  if (value === '.' || value === '..') return true
  return value.includes('/') || value.includes('\\') || value.startsWith('./') || value.startsWith('../')
}

function collectPositionals(args: string[], flagsWithValues: string[]): string[] {
  const out: string[] = []
  let skipNext = false
  let allowDash = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!allowDash && arg === '--') {
      allowDash = true
      continue
    }
    if (!allowDash && arg.startsWith('-')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx > 0) {
        const flag = arg.slice(0, eqIdx)
        if (flagsWithValues.includes(flag)) continue
      }
      if (flagsWithValues.includes(arg)) {
        if (i + 1 < args.length) skipNext = true
        continue
      }
      continue
    }
    out.push(arg)
  }
  return out
}

function isRedirectionToken(token?: string): boolean {
  if (!token) return false
  if (token === '<' || token === '>' || token === '>>' || token === '<<') return true
  const first = token[0]
  return first === '<' || first === '>'
}

function parseSedRangeToken(rawToken: string): { start: number; end: number } | undefined {
  const token = stripWrappingQuotes(rawToken) || rawToken
  const core = token.endsWith('p') ? token.slice(0, -1) : token
  const parts = core.split(',')
  if (parts.length === 1) {
    const n = parseInt(parts[0], 10)
    if (Number.isFinite(n)) return { start: n, end: n }
  } else if (parts.length === 2) {
    const a = parseInt(parts[0], 10)
    const b = parseInt(parts[1], 10)
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return { start: Math.min(a, b), end: Math.max(a, b) }
    }
  }
  return undefined
}

function parseHeadTailCount(flagValue: string | undefined): number | undefined {
  if (!flagValue) return undefined
  const unquoted = stripWrappingQuotes(flagValue) || flagValue
  const s = unquoted.startsWith('+') ? unquoted.slice(1) : unquoted
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
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

// 解析 exec 命令为读取/列表/搜索动作（复刻 Codex TUI 的语义化思路）
export function parseExploreActions(command: string[], cwd?: string): ExploreAction[] {
  try {
    const initialCwd = normalizeCwd(cwd)
    const tokens = normalizeCommandTokens(command)
    if (!tokens.length) return []
    const segments = splitCommandSegments(tokens)
    if (!segments.length) return []

    const actions: ExploreAction[] = []
    let currentCwd = initialCwd
    let pipelineCandidate: string | undefined
    const seenSearch = new Set<string>()
    const seenList = new Set<string>()

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i]
      const pipelineInput = seg.connectorBefore === '|' ? pipelineCandidate : undefined
      const ctx: ProcessContext = {
        cwd: currentCwd,
        initialCwd,
        pipelineInputPath: pipelineInput
      }
      const result = processSegment(seg, ctx)
      if (result.nextCwd !== undefined) currentCwd = result.nextCwd
      for (const action of result.actions) {
        if (action.kind === 'search') {
          const key = `${action.label}||${action.query || ''}||${action.target || ''}`
          if (seenSearch.has(key)) continue
          seenSearch.add(key)
        }
        if (action.kind === 'list') {
          const key = `${action.label}||${action.target || ''}`
          if (seenList.has(key)) continue
          seenList.add(key)
        }
        actions.push(action)
      }
      const nextSeg = segments[i + 1]
      if (nextSeg && nextSeg.connectorBefore === '|') {
        pipelineCandidate = result.pipelineOutputPath
      } else {
        pipelineCandidate = undefined
      }
    }

    return actions
  } catch {
    return []
  }
}

function processSegment(segment: CommandSegment, ctx: ProcessContext): ProcessResult {
  const tokens = segment.tokens
  if (!tokens.length) return { actions: [] }
  const [head, ...tail] = tokens

  const actions: ExploreAction[] = []
  const segmentText = segment.text

  switch (head) {
    case 'cd': {
      const target = tail[0]
      const next = resolvePath(ctx.cwd, ctx.initialCwd, target)
      return { actions: [], nextCwd: next || ctx.cwd }
    }

    case 'ls': {
      const positionals = collectPositionals(tail, LS_FLAGS_WITH_VALUES)
      const resolvedTarget =
        resolvePath(ctx.cwd, ctx.initialCwd, positionals[0]) || ctx.cwd || ctx.initialCwd
      const targetDisplay = shortDisplayPath(positionals[0] || resolvedTarget)
      actions.push({ kind: 'list', label: 'List ls', target: resolvedTarget, targetDisplay })
      return { actions }
    }

    case 'tree': {
      const depthIndex = tail.findIndex((t) => t === '-L')
      const depth =
        depthIndex >= 0 && depthIndex + 1 < tail.length
          ? parseInt(tail[depthIndex + 1], 10)
          : undefined
      const positionals = collectPositionals(tail, ['-L'])
      const resolvedTarget =
        resolvePath(ctx.cwd, ctx.initialCwd, positionals[0]) || ctx.cwd || ctx.initialCwd
      const targetDisplay = shortDisplayPath(positionals[0] || resolvedTarget)
      actions.push({
        kind: 'list',
        label: 'List tree',
        target: resolvedTarget,
        targetDisplay,
        flags: { depth: Number.isFinite(depth) ? depth : undefined }
      })
      return { actions }
    }

    case 'rg': {
      const hasFilesFlag = tail.includes('--files')
      const positionals = collectPositionals(tail, RG_FLAGS_WITH_VALUES)
      if (hasFilesFlag) {
        const resolvedTarget =
          resolvePath(ctx.cwd, ctx.initialCwd, positionals[0]) || ctx.cwd || ctx.initialCwd
        const firstNonFlag = tail.find(
          (tok) => !!tok && tok !== '--' && !tok.startsWith('-') && !isRedirectionToken(tok)
        )
        const targetDisplay = shortDisplayPath(positionals[0] || firstNonFlag || resolvedTarget)
        actions.push({
          kind: 'list',
          label: 'List rg --files',
          target: resolvedTarget,
          targetDisplay
        })
        return { actions }
      }
      const rawQuery = positionals[0]
      const query = stripWrappingQuotes(rawQuery) || rawQuery
      if (!query) return { actions: [] }
      const targetToken = positionals[1]
      const resolvedTarget = resolvePath(ctx.cwd, ctx.initialCwd, targetToken)
      const targetDisplay = shortDisplayPath(targetToken ?? resolvedTarget)
      const flags = extractRgFlags(segmentText)
      actions.push({
        kind: 'search',
        label: 'Search',
        query,
        target: resolvedTarget,
        targetDisplay,
        flags
      })
      return { actions }
    }

    case 'grep': {
      const positionals = collectPositionals(tail, GREP_FLAGS_WITH_VALUES)
      const query = stripWrappingQuotes(positionals[0]) || positionals[0]
      if (!query) return { actions: [] }
      const resolvedTarget = resolvePath(ctx.cwd, ctx.initialCwd, positionals[1])
      const targetDisplay = shortDisplayPath(positionals[1] || resolvedTarget)
      const flags = extractGrepFlags(segmentText)
      actions.push({
        kind: 'search',
        label: 'Search',
        query,
        target: resolvedTarget,
        targetDisplay,
        flags
      })
      return { actions }
    }

    case 'fd': {
      const positionals = collectPositionals(tail, FD_FLAGS_WITH_VALUES)
      let query: string | undefined
      let resolvedTarget: string | undefined
      let targetToken: string | undefined
      if (positionals.length === 1) {
        if (isPathish(positionals[0])) {
          resolvedTarget = resolvePath(ctx.cwd, ctx.initialCwd, positionals[0])
          targetToken = positionals[0]
        } else {
          query = stripWrappingQuotes(positionals[0]) || positionals[0]
        }
      } else if (positionals.length >= 2) {
        query = stripWrappingQuotes(positionals[0]) || positionals[0]
        resolvedTarget = resolvePath(ctx.cwd, ctx.initialCwd, positionals[1])
        targetToken = positionals[1]
      }
      if (!query && !resolvedTarget) return { actions: [] }
      const targetDisplay = shortDisplayPath(targetToken ?? resolvedTarget)
      const f = extractFdFlags(segmentText)
      actions.push({
        kind: 'search',
        label: 'Search',
        query,
        target: resolvedTarget,
        targetDisplay,
        flags: { type: f.type, hidden: f.hidden }
      })
      return { actions }
    }

    case 'find': {
      const info = parseFindTail(tail, ctx)
      const query = stripWrappingQuotes(info.query) || info.query
      const targetDisplay = info.targetDisplay
      const searchFlags = info.flags?.type ? { type: info.flags.type } : undefined
      actions.push({
        kind: 'search',
        label: 'Search',
        query,
        target: info.target,
        targetDisplay,
        flags: searchFlags
      })
      return { actions }
    }

    case 'cat': {
      const files = collectCatPaths(tail, ctx)
      if (!files.length) return { actions: [] }
      for (const file of files) {
        actions.push({ kind: 'read', path: file, start: 1, end: 0 as any })
      }
      return { actions, pipelineOutputPath: files[0] }
    }

    case 'head': {
      const { count, files } = parseHeadTailArgs(tail, ctx)
      if (!count || !files.length) return { actions: [] }
      for (const file of files) actions.push({ kind: 'read', path: file, start: 1, end: count })
      return { actions }
    }

    case 'tail': {
      const { count, files } = parseHeadTailArgs(tail, ctx)
      if (!count || !files.length) return { actions: [] }
      for (const file of files) {
        const a: any = { kind: 'read', path: file, start: 1, end: 0 as any }
        a.tail = count
        actions.push(a)
      }
      return { actions }
    }

    case 'nl': {
      const fileToken = tail.find((t) => !t.startsWith('-'))
      const file = resolvePath(ctx.cwd, ctx.initialCwd, fileToken)
      return { actions: [], pipelineOutputPath: file }
    }

    case 'sed': {
      const hasNumeric = tail.some((t) => parseSedRangeToken(t))
      if (!tail.includes('-n') || !hasNumeric) return { actions: [] }
      const rangeToken = tail.find((t) => parseSedRangeToken(t))
      if (!rangeToken) return { actions: [] }
      const range = parseSedRangeToken(rangeToken)
      if (!range) return { actions: [] }
      const fileIndex = tail.findIndex(
        (t) =>
          t !== rangeToken &&
          !t.startsWith('-') &&
          !isRedirectionToken(t) &&
          t !== '|'
      )
      const fileToken = fileIndex >= 0 ? tail[fileIndex] : undefined
      let path = fileToken ? resolvePath(ctx.cwd, ctx.initialCwd, fileToken) : undefined
      if (!path && ctx.pipelineInputPath) path = ctx.pipelineInputPath
      if (!path && fileToken && !isRedirectionToken(fileToken)) path = fileToken
      if (!path) return { actions: [] }
      actions.push({ kind: 'read', path, start: range.start, end: range.end })
      return { actions, pipelineOutputPath: path }
    }

    default:
      return { actions: [] }
  }
}

function collectCatPaths(args: string[], ctx: ProcessContext): string[] {
  if (
    args.some((tok) => tok === '>' || tok === '>>' || tok === '<<' || tok === '<' || tok.startsWith('>') || tok.startsWith('<'))
  ) {
    return []
  }
  const out: string[] = []
  for (const tok of args) {
    if (!tok) continue
    if (tok.startsWith('-')) continue
    const path = resolvePath(ctx.cwd, ctx.initialCwd, stripWrappingQuotes(tok) || tok)
    if (path && !out.includes(path)) out.push(path)
  }
  return out
}

function parseHeadTailArgs(
  args: string[],
  ctx: ProcessContext
): { count?: number; files: string[] } {
  let count: number | undefined
  const files: string[] = []
  let i = 0
  while (i < args.length) {
    const tok = args[i]
    if (tok === '-n' && i + 1 < args.length) {
      count = parseHeadTailCount(args[i + 1])
      i += 2
      continue
    }
    if (tok.startsWith('-n')) {
      count = parseHeadTailCount(tok.slice(2))
      i += 1
      continue
    }
    if (tok.startsWith('-')) {
      i += 1
      continue
    }
    const path = resolvePath(ctx.cwd, ctx.initialCwd, stripWrappingQuotes(tok) || tok)
    if (path) files.push(path)
    i += 1
  }
  return { count, files }
}

function parseFindTail(tail: string[], ctx: ProcessContext): {
  query?: string
  target?: string
  targetDisplay?: string
  flags?: { depth?: number; type?: string; recursive?: boolean }
} {
  let target: string | undefined
  let targetDisplay: string | undefined
  let query: string | undefined
  let depth: number | undefined
  let type: string | undefined
  let recursive: boolean | undefined

  for (let i = 0; i < tail.length; i += 1) {
    const tok = tail[i]
    if (!target && !tok.startsWith('-') && tok !== '!' && tok !== '(' && tok !== ')') {
      const stripped = stripWrappingQuotes(tok) || tok
      target = resolvePath(ctx.cwd, ctx.initialCwd, stripped)
      targetDisplay = shortDisplayPath(tok)
      continue
    }
    if (tok === '-type' && i + 1 < tail.length) {
      type = tail[i + 1]
      i += 1
      continue
    }
    if (tok === '-maxdepth' && i + 1 < tail.length) {
      depth = parseInt(tail[i + 1], 10)
      i += 1
      continue
    }
    if (FIND_UNARY_OPERATORS.has(tok) && i + 1 < tail.length) {
      query = tail[i + 1]
      i += 1
      continue
    }
    if (tok === '-mindepth') {
      recursive = true
    }
  }

  const flags =
    depth !== undefined || type !== undefined || recursive
      ? { depth, type, recursive }
      : undefined

  if (!targetDisplay && target) {
    targetDisplay = shortDisplayPath(target)
  }

  return {
    query,
    target,
    targetDisplay,
    flags
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
