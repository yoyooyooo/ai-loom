import { renderPatchDiff } from './ws-render-utils'

export type ExecBuildCtx = { command: string[]; cwd?: string; callId?: string }

export type StepBuildResult = {
  title: string
  meta: any
  tags?: string[]
  body?: string
}

function lastName(p?: string): string | undefined {
  if (!p) return undefined
  const cleaned = p.replace(/\/+$/g, '')
  const segs = cleaned.split('/')
  return segs[segs.length - 1] || cleaned
}

function toFiniteNumber(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function countContentLines(content: string): number {
  const cleaned = content.replace(/\r/g, '')
  if (!cleaned) return 0
  const parts = cleaned.split('\n')
  if (parts.length && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

function countDiffStats(diff: string): { adds: number; dels: number } {
  const cleaned = diff.replace(/\r/g, '')
  const lines = cleaned.split('\n')
  let adds = 0
  let dels = 0
  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue
    if (line.startsWith('+')) {
      adds += 1
    } else if (line.startsWith('-')) {
      dels += 1
    }
  }
  return { adds, dels }
}

function derivePatchCountsFromChanges(changes: any): { adds: number; dels: number } {
  let adds = 0
  let dels = 0
  try {
    for (const change of Object.values(changes || {})) {
      if (!change || typeof change !== 'object') continue
      if (change.update && typeof change.update.unified_diff === 'string') {
        const stats = countDiffStats(change.update.unified_diff)
        adds += stats.adds
        dels += stats.dels
        continue
      }
      if (change.add && typeof change.add.content === 'string') {
        adds += countContentLines(change.add.content)
      }
      if (change.delete && typeof change.delete.content === 'string') {
        dels += countContentLines(change.delete.content)
      }
    }
  } catch {}
  return { adds, dels }
}

export function buildExecFallbackStepParts(ctx: ExecBuildCtx): StepBuildResult {
  const cmdStr = (ctx.command || []).join(' ')
  const cwd = ctx.cwd || ''
  const title = `${cmdStr}${cwd ? ` (cwd=${cwd})` : ''}`
  const meta = { command: ctx.command, cwd: ctx.cwd, callId: ctx.callId }
  return { title, meta }
}

// 从 exec 命令中识别 apply_patch 补丁块并构造 patch 步骤（简版计算 adds/dels/首文件名）
export function buildPatchFromApplyPatchCommand(ctx: ExecBuildCtx): StepBuildResult {
  const src = (ctx.command || []).join('\n')
  let headPath: string | undefined
  let adds = 0
  let dels = 0
  let patchText = ''
  try {
    const m = src.match(/\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)/)
    headPath = m ? m[1].trim() : undefined
    const patchBlockMatch = src.match(/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/)
    patchText = patchBlockMatch ? patchBlockMatch[0] : ''
    if (patchText) {
      const lines = patchText.split(/\n/)
      for (const ln of lines) {
        if (ln.startsWith('+')) adds += 1
        else if (ln.startsWith('-')) dels += 1
      }
    }
  } catch {}
  const name = lastName(headPath)
  const title = name ? `patch ${name}` : `patch (apply_patch)`
  const meta = {
    patch: { adds, dels, firstPath: headPath },
    command: ctx.command,
    cwd: ctx.cwd,
    callId: ctx.callId
  }
  const body = patchText
  return { title, meta, body }
}

// patch 工具（begin）→ 标题/正文/元信息
export function buildPatchToolBeginParts(
  p: {
    files?: number
    firstPath?: string
    adds?: number
    dels?: number
    autoApproved?: boolean
    changes?: any
  },
  limits: { patchMaxFiles: number; patchMaxChars: number },
  callId?: string
): StepBuildResult {
  const headPath = p.firstPath
  const changes = p.changes
  const derivedCounts = derivePatchCountsFromChanges(changes)
  const adds = toFiniteNumber(p.adds) ?? derivedCounts.adds
  const dels = toFiniteNumber(p.dels) ?? derivedCounts.dels
  const derivedFiles = (() => {
    try {
      return Object.keys(changes || {}).length
    } catch {
      return 0
    }
  })()
  const files = toFiniteNumber(p.files) ?? derivedFiles
  const name = lastName(headPath)
  const safeFiles = typeof files === 'number' && files > 0 ? files : Math.max(derivedFiles, 1)
  const extra = headPath && safeFiles > 1 ? ` (+${safeFiles - 1})` : ''
  const title = name ? `patch ${name}${extra}` : `patch ${safeFiles} files`
  const body = renderPatchDiff(changes, limits.patchMaxFiles, limits.patchMaxChars)
  const meta = {
    patch: {
      adds,
      dels,
      files: safeFiles,
      firstPath: headPath,
      autoApproved: p.autoApproved,
      changes
    },
    callId
  }
  return { title, body, meta }
}

export function buildMcpBeginParts(
  p: { server?: string; tool?: string; args?: any },
  callId?: string
): StepBuildResult {
  const server = typeof p.server === 'string' ? p.server : ''
  const tool = typeof p.tool === 'string' ? p.tool : ''
  const title = server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : 'mcp'
  const meta = { server, tool, args: p.args, callId }
  return { title, meta }
}

export function buildMcpEndMeta(p: { server?: string; tool?: string; result?: any }) {
  const server = typeof p.server === 'string' ? p.server : ''
  const tool = typeof p.tool === 'string' ? p.tool : ''
  return { server, tool, result: p.result }
}

// read/list/search 步骤构建（供 WS 与 Resume 复用）
export function buildReadStepParts(
  action: { kind: 'read'; path: string; start: number; end: number },
  ctx: ExecBuildCtx
): StepBuildResult {
  const path = action.path
  const name = lastName(path) || path
  const title = `Read ${name} (lines: ${action.start}-${action.end})`
  const tail = (action as any)?.tail as number | undefined
  const meta: any = {
    file: path,
    start: action.start,
    end: action.end,
    command: ctx.command,
    cwd: ctx.cwd,
    callId: ctx.callId
  }
  if (tail && tail > 0) meta.tailLines = tail
  return { title, meta, tags: [name] as string[] }
}

export function buildListStepParts(
  action: { kind: 'list'; label: string; target?: string; targetDisplay?: string },
  ctx: ExecBuildCtx
): StepBuildResult {
  const target = action.target ? String(action.target).replace(/\/+$/g, '') : undefined
  const targetDisplay = action.targetDisplay
    ? String(action.targetDisplay).replace(/\/+$/g, '')
    : undefined
  const nameSource = targetDisplay || target || ''
  const name = lastName(nameSource)
  const flags = (action as any)?.flags as
    | { depth?: number; type?: string; recursive?: boolean }
    | undefined
  const parts: string[] = []
  if (flags?.depth != null) parts.push(`depth=${flags.depth}`)
  if (flags?.type) parts.push(`type=${flags.type}`)
  if (flags?.recursive) parts.push('recursive')
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  const title = name ? `${action.label} ${name}${suffix}` : `${action.label}${suffix}`
  const meta = {
    target,
    targetDisplay,
    label: action.label,
    listFlagsText: parts.join(', '),
    command: ctx.command,
    cwd: ctx.cwd,
    callId: ctx.callId
  }
  return { title, meta, tags: name ? [name] : undefined }
}

export function buildSearchStepParts(
  action: {
    kind: 'search'
    label: string
    target?: string
    targetDisplay?: string
    query?: string
  },
  ctx: ExecBuildCtx
): StepBuildResult {
  const cmdStr = (ctx.command || []).join(' ')
  let target = action.target ? String(action.target).replace(/\/+$/g, '') : undefined
  let targetDisplay = action.targetDisplay
    ? String(action.targetDisplay).replace(/\/+$/g, '')
    : undefined
  if (!target) {
    const mt = cmdStr.match(
      /\brg\b[^|;]*?['"][^'"]+['"][^|;]*?\s+(?:['"]([^'"]+)['"]|([^\s'\";&|]+))/
    )
    const raw = (mt && (mt[1] || mt[2])) || undefined
    if (raw && !raw.startsWith('$(')) {
      target = String(raw).replace(/\/+$/g, '')
      targetDisplay = targetDisplay ?? target
    }
  }
  if (!targetDisplay && target) {
    targetDisplay = target
  }
  const name = lastName(targetDisplay || target)
  const q0 = String((action as any).query || '').trim()
  let fixedQuery = q0 && q0.length > 1 ? q0 : ''
  if (!fixedQuery) {
    const m = cmdStr.match(/\brg\b[^|;]*?['"]([^'"]+)['"]/)
    fixedQuery = m && m[1] ? m[1] : ''
  }
  // 预提炼多关键词（以 | 分隔），生成 queries/queriesDisplay/queriesMore，避免组件层再做拆分
  const queries = (fixedQuery || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  const queriesDisplay = queries.slice(0, 3)
  const queriesMore = Math.max(0, queries.length - queriesDisplay.length)
  const displayQuery =
    queries.length > 1
      ? `${queriesDisplay.join(' | ')}${queriesMore > 0 ? ` (+${queriesMore})` : ''}`
      : fixedQuery
  const f = (action as any)?.flags as
    | { ci?: boolean; word?: boolean; type?: string; glob?: string; hidden?: boolean }
    | undefined
  const parts: string[] = []
  if (f?.ci) parts.push('ci')
  if (f?.word) parts.push('word')
  if (f?.type) parts.push(`type=${f.type}`)
  if (f?.glob) parts.push(`glob=${f.glob}`)
  if (f?.hidden) parts.push('hidden')
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  const title = fixedQuery
    ? name
      ? `Search ${fixedQuery} in ${name}${suffix}`
      : `Search ${fixedQuery}${suffix}`
    : cmdStr || 'search'
  const meta = {
    target,
    targetDisplay,
    // 展示层期望完整关键词，不做“(+N)”折叠；交由 CSS 处理截断
    query: fixedQuery || q0,
    queries,
    queriesDisplay,
    queriesMore,
    searchFlagsText: parts.join(', '),
    command: ctx.command,
    cwd: ctx.cwd,
    callId: ctx.callId
  }
  return { title, meta, tags: name ? [name] : undefined }
}
