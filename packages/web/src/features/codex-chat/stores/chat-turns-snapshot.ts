import { createId } from '@/lib/id'
import type { Turn, TurnStep } from './chat-turns'
import { summarizeFirstLine, nowISO, stripDuplicatedTitle } from './chat-turns-utils'
import { renderPatchDiff } from '@/features/codex-chat/services/ws-render-utils'
import { parseExploreActions } from '@/features/codex-chat/utils/explore-utils'

export type SnapshotHistoryItem = {
  role: 'user' | 'assistant' | 'reasoning'
  text: string
  reasoning?: string | null
}

export type SnapshotEvent = {
  method: string
  params?: Record<string, any> | null | undefined
}

export function buildTurnsFromHistory(history: SnapshotHistoryItem[], conversationId: string | undefined): {
  turns: Turn[]
  nextSeq: number
} {
  const turns: Turn[] = []
  let seq = 0
  let current: Turn | undefined

  const flush = () => {
    if (!current) return
    if ((current as any).reasoning && !(current as any).reasoning.title) {
      ;(current as any).reasoning.title = summarizeFirstLine((current as any).reasoning.content)
    }
    if (!current.completedAt) current.completedAt = nowISO()
    if (current.status !== 'failed' && current.status !== 'aborted') {
      current.status = 'completed'
    }
    turns.push(current)
    current = undefined
  }

  const ensureCurrent = (userText?: string): Turn => {
    if (current) return current
    seq += 1
    const ts = nowISO()
    current = {
      id: createId('turn-history'),
      seq,
      conversationId,
      startedAt: ts,
      status: 'streaming' as any,
      user: { text: userText ?? '', ts },
      assistant: { text: '' },
      steps: []
    } as Turn
    return current
  }

  history.forEach((item) => {
    const text = item.text ?? ''
    if (item.role === 'user') {
      flush()
      const turn = ensureCurrent(text)
      turn.user = { text, ts: nowISO() }
      return
    }
    if (item.role === 'reasoning') {
      const content = item.reasoning ?? item.text ?? ''
      if (!content) return
      const turn = ensureCurrent()
      ;(turn as any).reasoning = (turn as any).reasoning || { content: '' }
      ;(turn as any).reasoning.content = ((turn as any).reasoning.content || '') + (content ? `${(turn as any).reasoning.content ? '\n\n' : ''}${content}` : '')
      ;(turn as any).reasoning.title = summarizeFirstLine((turn as any).reasoning.content)
      return
    }
    const turn = ensureCurrent()
    turn.assistant = { text, ts: nowISO() }
    turn.status = 'completed' as any
    flush()
  })

  flush()
  return { turns, nextSeq: seq }
}

export function applyEventsToTurns(turns: Turn[], events: SnapshotEvent[]) {
  if (!events || events.length === 0) return
  let turnIdx = 0
  let target: Turn | undefined = turns[turnIdx]
  let nextSeq = Math.max(0, ...turns.map((t) => t.seq))
  const toolIndex = new Map<string, { turnIdx: number; stepIdx: number }>()
  // 记录语义化（read/list/search）步骤索引，用于输出/收尾同步
  const semanticIndex = new Map<string, { turnIdx: number; stepIdxs: number[] }>()

  const newTurn = (userText?: string): Turn => {
    const ts = nowISO()
    nextSeq += 1
    return {
      id: createId('turn-events'),
      seq: nextSeq,
      startedAt: ts,
      status: 'streaming' as any,
      user: { text: userText ?? '', ts },
      assistant: { text: '' },
      steps: []
    } as Turn
  }

  const ensureTarget = (opts?: { userText?: string; forceNew?: boolean }) => {
    if (!opts?.forceNew && target) return target
    if (opts?.forceNew || !target) {
      const turn = newTurn(opts?.userText)
      turns.push(turn)
      turnIdx = turns.length - 1
      target = turn
      return target
    }
    return target
  }
  const advanceTurn = () => {
    // 收尾：由 UI 侧按 status/steps 推导 working 状态
    target = undefined
    turnIdx += 1
    if (turnIdx < turns.length) target = turns[turnIdx]
  }

  events.forEach((evt) => {
    const method = evt.method
    const params = evt.params ?? {}
    const seqFromEvt = typeof (params as any)?.turnSeq === 'number' ? Number((params as any).turnSeq) : undefined

    if (method === 'chat.message.completed') {
      const text = typeof (params as any)?.text === 'string' ? String((params as any).text) : ''
      if (text.trim().toLowerCase() === 'compact task completed') {
        let attachIdx = turnIdx
        let t = target
        if (seqFromEvt) {
          const idx = turns.findIndex((x) => x.seq === seqFromEvt)
          if (idx >= 0) {
            attachIdx = idx
            t = turns[idx]
          }
        }
        const isTransient = !!t && t.id.startsWith('turn-events_') && !t.assistant?.text && (!Array.isArray(t.steps) || t.steps.length === 0)
        if (isTransient && attachIdx > 0) {
          turns.splice(attachIdx, 1)
          attachIdx -= 1
          t = turns[attachIdx]
          turnIdx = attachIdx
          target = t
        } else if (!t && turns.length > 0) {
          attachIdx = turns.length - 1
          t = turns[attachIdx]
          turnIdx = attachIdx
          target = t
        } else if (!t) {
          return
        }
        const step: TurnStep = {
          id: createId('info'),
          kind: 'info',
          title: '[Compact] 任务完成',
          status: 'completed',
          ts: nowISO(),
          meta: { compactDone: true }
        } as any
        t!.steps.push(step)
        return
      }
    }

    if (method === 'chat.turn.started') {
      if (!seqFromEvt) {
        ensureTarget()
      } else {
        const idx = turns.findIndex((x) => x.seq === seqFromEvt)
        if (idx === -1) {
          const t = newTurn()
          t.seq = seqFromEvt
          turns.push(t)
          turnIdx = turns.length - 1
          target = t
        } else {
          turnIdx = idx
          target = turns[idx]
        }
      }
      return
    }
    if (method === 'chat.info.user_message') {
      const text = typeof (params as any)?.text === 'string' ? String((params as any).text) : ''
      if (seqFromEvt) {
        const idx = turns.findIndex((x) => x.seq === seqFromEvt)
        if (idx === -1) {
          const t = newTurn(text)
          t.seq = seqFromEvt
          turns.push(t)
          turnIdx = turns.length - 1
          target = t
        } else {
          const t = turns[idx]
          t.user = { text, ts: nowISO() }
          turnIdx = idx
          target = t
        }
      } else {
        if (target) {
          target.user = { text, ts: nowISO() }
        } else {
          const t = ensureTarget({ userText: text, forceNew: false })
          if (t) t.user = { text, ts: nowISO() }
        }
      }
      return
    }
    if (
      method === 'chat.turn.complete' ||
      method === 'chat.message.completed' ||
      method === 'chat.message.failed' ||
      method === 'chat.message.aborted'
    ) {
      if (seqFromEvt) {
        const idx = turns.findIndex((x) => x.seq === seqFromEvt)
        if (idx >= 0) {
          turnIdx = idx
          target = turns[idx]
        }
      }
      if (method === 'chat.message.failed') {
        if (target) target.status = 'failed' as any
      } else if (method === 'chat.message.aborted') {
        if (target) target.status = 'aborted' as any
      } else if (method === 'chat.message.completed') {
        if (target) {
          const text = typeof (params as any)?.text === 'string' ? String((params as any).text) : ''
          const existing = target.assistant?.text || ''
          target.assistant = { text: text || existing, ts: nowISO() }
          target.status = (target.status as any) === 'failed' || (target.status as any) === 'aborted' ? (target.status as any) : 'completed'
        }
      }
      // 对齐实时路径：补齐 completedAt
      if (target && !target.completedAt) target.completedAt = nowISO()
      advanceTurn()
      return
    }
    if (method === 'chat.message.delta') {
      const delta = typeof (params as any)?.delta === 'string' ? String((params as any).delta) : ''
      if (delta) {
        const t = ensureTarget()
        if (t) t.assistant = { ...(t.assistant || { text: '' }), text: (t.assistant?.text || '') + delta }
      }
      return
    }

    let t: Turn | undefined
    if (seqFromEvt && Number.isFinite(seqFromEvt)) {
      const idx = turns.findIndex((x) => x.seq === seqFromEvt)
      if (idx >= 0) {
        t = turns[idx]
      }
    }
    if (!t) t = ensureTarget()
    if (!t) return
    const tIndex = turns.findIndex((x) => x.id === t!.id)

    if (method === 'chat.reasoning.end') {
      const text = typeof (params as any)?.text === 'string' ? String((params as any).text) : ''
      if (text && !t.steps.some((s) => s.kind === 'thinking')) {
        const title = summarizeFirstLine(text)
        // 移除正文中与封面标题重复的首行
        const body = stripDuplicatedTitle(text, title)
        t.steps.push({ id: createId('thinking'), kind: 'thinking', title: title ? `thinking: ${title}` : 'thinking', body, status: 'completed', ts: nowISO(), meta: { thinking: true } } as any)
      }
      return
    }
    if (method === 'chat.info.turn_diff') {
      const diff = typeof (params as any)?.diff === 'string' ? String((params as any).diff) : ''
      if (diff) {
        const body = `Turn diff 更新:\n\n\`\`\`diff\n${diff}\n\`\`\``
        const step: TurnStep = { id: createId('info'), kind: 'info', title: body, status: 'completed', ts: nowISO() } as any
        t.steps.push(step)
      }
      return
    }
    if (method === 'chat.info.plan_update') {
      const plan = Array.isArray((params as any)?.plan) ? (params as any).plan : []
      const explanation = typeof (params as any)?.explanation === 'string' ? (params as any).explanation : ''
      const title = explanation ? `Plan 更新：${explanation}` : 'Plan 更新'
      const lines = plan
        .map((step: any, idx: number) => {
          const text = typeof step?.step === 'string' ? step.step : `Step ${idx + 1}`
          const status = typeof step?.status === 'string' ? step.status : 'unknown'
          const mark = status === 'completed' ? '✔' : status === 'in_progress' ? '…' : '·'
          return `${mark} ${text}`
        })
        .join('\n')
      const body = lines
      const step: TurnStep = { id: createId('plan'), kind: 'plan', title, body, status: 'completed', ts: nowISO(), meta: { plan } } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.approval.exec') {
      const command = Array.isArray((params as any)?.command) ? (params as any).command.join(' ') : ''
      const cwd = typeof (params as any)?.cwd === 'string' ? (params as any).cwd : ''
      const reason = typeof (params as any)?.reason === 'string' ? (params as any).reason : ''
      const summary = [`[审批请求] 执行命令 ${command || '(unknown)'}（已自动批准）`]
      if (cwd) summary.push(`cwd=${cwd}`)
      if (reason) summary.push(`理由：${reason}`)
      const step: TurnStep = { id: createId('info'), kind: 'info', title: summary.join('\n'), status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.approval.patch') {
      const count = typeof (params as any)?.changeCount === 'number' ? (params as any).changeCount : undefined
      const reason = typeof (params as any)?.reason === 'string' ? (params as any).reason : ''
      const grant = typeof (params as any)?.grantRoot === 'string' ? (params as any).grantRoot : ''
      const summary = [`[审批请求] 应用补丁${count != null ? ` (${count} files)` : ''}（已自动批准）`]
      if (reason) summary.push(`理由：${reason}`)
      if (grant) summary.push(`请求写入根：${grant}`)
      const step: TurnStep = { id: createId('info'), kind: 'info', title: summary.join('\n'), status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.background') {
      const message = typeof (params as any)?.message === 'string' ? (params as any).message : ''
      if (message) {
        const step: TurnStep = { id: createId('info'), kind: 'info', title: `[系统] ${message}`, status: 'completed', ts: nowISO() } as any
        t.steps.push(step)
      }
      return
    }
    if (method === 'chat.info.web_search.begin') {
      const step: TurnStep = { id: createId('info'), kind: 'info', title: '[web-search] 开始检索…', status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.web_search.end') {
      const q = typeof (params as any)?.query === 'string' ? (params as any).query : ''
      const step: TurnStep = { id: createId('info'), kind: 'info', title: `[web-search] 完成${q ? `：${q}` : ''}` as string, status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.view_image') {
      const path = typeof (params as any)?.path === 'string' ? (params as any).path : ''
      const step: TurnStep = { id: createId('info'), kind: 'info', title: `[view-image] ${path}`, status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.conversation_path') {
      const path = typeof (params as any)?.path === 'string' ? (params as any).path : ''
      if (path) {
        const step: TurnStep = { id: createId('info'), kind: 'info', title: `[rollout] ${path}`, status: 'completed', ts: nowISO() } as any
        t.steps.push(step)
      }
      return
    }
    if (method === 'chat.info.review.entered') {
      const step: TurnStep = { id: createId('info'), kind: 'info', title: '[review] 进入审查模式', status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.info.review.exited') {
      const step: TurnStep = { id: createId('info'), kind: 'info', title: '[review] 退出审查模式', status: 'completed', ts: nowISO() } as any
      t.steps.push(step)
      return
    }
    if (method === 'chat.tool.exec.begin') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId || toolIndex.has(callId)) return
      const command = Array.isArray((params as any)?.command) ? (params as any).command.map((item: any) => String(item)) : []
      const cwd = typeof (params as any)?.cwd === 'string' ? (params as any).cwd : undefined
      // 语义化：解析 read/list/search，并增加对应步骤（标题语义化；正文双栏与 exec 一致：入参=原始命令，输出=结果）
      try {
        const acts = parseExploreActions(command, cwd)
        if (Array.isArray(acts) && acts.length > 0) {
          const idxs: number[] = []
          for (const action of acts) {
            if (action.kind === 'read') {
              const path = action.path
              const name = path.replace(/\/+$/g, '').split('/').pop() || path
              const title = `Read ${name} (lines: ${action.start}-${action.end})`
              t.steps.push({ id: createId('read'), kind: 'read', title, status: 'completed', ts: nowISO(), meta: { file: path, start: action.start, end: action.end, command, cwd } } as any)
              idxs.push(t.steps.length - 1)
            } else if (action.kind === 'list') {
              const target = action.target ? String(action.target).replace(/\/+$/g, '') : undefined
              const name = target ? target.split('/').pop() || target : undefined
              const title = name ? `${action.label} ${name}` : action.label
              t.steps.push({ id: createId('list'), kind: 'list', title, status: 'completed', ts: nowISO(), meta: { target, label: action.label, command, cwd }, tags: name ? [name] : undefined } as any)
              idxs.push(t.steps.length - 1)
            } else if (action.kind === 'search') {
              const target = action.target ? String(action.target).replace(/\/+$/g, '') : undefined
              const name = target ? target.split('/').pop() || target : undefined
              const base = `Search ${String((action as any).query)}`
              const title = name ? `${base} in ${name}` : base
              t.steps.push({ id: createId('search'), kind: 'search', title, status: 'completed', ts: nowISO(), meta: { target, query: (action as any).query, command, cwd }, tags: name ? [name] : undefined } as any)
              idxs.push(t.steps.length - 1)
            }
          }
          if (idxs.length > 0) {
            semanticIndex.set(callId, { turnIdx: tIndex, stepIdxs: idxs })
          }
          // 命中语义化时不再生成原始 exec 步骤，避免重复
          return
        }
      } catch {
        // 忽略解析错误，不影响 exec 展示
      }
      // 未命中语义化时，尝试识别 apply_patch 作为 patch 步骤；否则回退到原始 exec
      const src = command.join('\n')
      const isApplyPatch = /apply_patch|applypatch|git\s+apply/i.test(src) || /\*\*\*\s+Begin Patch/.test(src)
      if (isApplyPatch) {
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
        const name = headPath ? headPath.replace(/\/+$/g, '').split('/').pop() || headPath : undefined
        const title = name ? `patch ${name}` : `patch (apply_patch)`
        const step: TurnStep = { id: createId('patch'), kind: 'patch', title, status: 'streaming', ts: nowISO(), tags: [`+${adds}-${dels}`], meta: { firstPath: headPath, adds, dels, command, cwd }, body: patchText } as any
        t.steps.push(step)
        const stepIdx = t.steps.length - 1
        if (callId) toolIndex.set(callId, { turnIdx: tIndex, stepIdx })
      } else {
        const step: TurnStep = { id: createId('exec'), kind: 'exec', title: `${command.join(' ')}${cwd ? ` (cwd=${cwd})` : ''}`, status: 'streaming', ts: nowISO(), meta: { command, cwd } } as any
        t.steps.push(step)
        const stepIdx = t.steps.length - 1
        toolIndex.set(callId, { turnIdx: tIndex, stepIdx })
      }
      return
    }
    if (method === 'chat.tool.exec.output') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      const text = typeof (params as any)?.text === 'string' ? (params as any).text : ''
      if (!callId || !text) return
      // 换行友好拼接
      const mergeStepBody = (prev: string | undefined, next: string) => {
        if (!prev) return next
        if (!next) return prev
        return prev.length === 0 ? next : `${prev}${prev.endsWith('\n') ? '' : '\n'}${next}`
      }
      if (toolIndex.has(callId)) {
        const idx = toolIndex.get(callId)!
        const step = turns[idx.turnIdx].steps[idx.stepIdx]
        step.body = mergeStepBody(step.body, text)
        step.status = step.status === 'streaming' ? step.status : 'streaming'
        // 同步到语义化步骤（若存在）
        const sem = semanticIndex.get(callId)
        if (sem && sem.turnIdx === idx.turnIdx) {
          for (const sIdx of sem.stepIdxs) {
            const s = turns[sem.turnIdx].steps[sIdx]
            s.body = mergeStepBody(s.body, text)
          }
        }
      } else if (semanticIndex.has(callId)) {
        const sem = semanticIndex.get(callId)!
        for (const sIdx of sem.stepIdxs) {
          const s = turns[sem.turnIdx].steps[sIdx]
          s.body = mergeStepBody(s.body, text)
          s.status = s.status === 'streaming' ? s.status : 'streaming'
        }
      }
      return
    }
    if (method === 'chat.tool.exec.end') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId) return
      if (toolIndex.has(callId)) {
        const idx = toolIndex.get(callId)!
        const step = turns[idx.turnIdx].steps[idx.stepIdx]
        step.status = 'completed'
        ;(step as any).meta = { ...(step as any).meta, exitCode: (params as any)?.exitCode, stdout: (params as any)?.stdout, stderr: (params as any)?.stderr }
        // 同步到语义化步骤（若存在）
        const sem = semanticIndex.get(callId)
        if (sem && sem.turnIdx === idx.turnIdx) {
          for (const sIdx of sem.stepIdxs) {
            const s = turns[sem.turnIdx].steps[sIdx]
            s.status = 'completed'
            ;(s as any).meta = { ...(s as any).meta, exitCode: (params as any)?.exitCode, stdout: (params as any)?.stdout, stderr: (params as any)?.stderr }
          }
          semanticIndex.delete(callId)
        }
        toolIndex.delete(callId)
      } else if (semanticIndex.has(callId)) {
        const sem = semanticIndex.get(callId)!
        for (const sIdx of sem.stepIdxs) {
          const s = turns[sem.turnIdx].steps[sIdx]
          s.status = 'completed'
          ;(s as any).meta = { ...(s as any).meta, exitCode: (params as any)?.exitCode, stdout: (params as any)?.stdout, stderr: (params as any)?.stderr }
        }
        semanticIndex.delete(callId)
      }
      return
    }
    if (method === 'chat.tool.mcp.begin') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId || toolIndex.has(callId)) return
      const server = typeof (params as any)?.server === 'string' ? (params as any).server : ''
      const tool = typeof (params as any)?.tool === 'string' ? (params as any).tool : ''
      const args = (params as any)?.arguments
      const step: TurnStep = { id: createId('mcp'), kind: 'mcp', title: server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : 'mcp', status: 'streaming', ts: nowISO(), meta: { server, tool, args } } as any
      t.steps.push(step)
      const stepIdx = t.steps.length - 1
      toolIndex.set(callId, { turnIdx: tIndex, stepIdx })
      return
    }
    if (method === 'chat.tool.mcp.end') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId || !toolIndex.has(callId)) return
      const idx = toolIndex.get(callId)!
      const step = turns[idx.turnIdx].steps[idx.stepIdx]
      step.status = 'completed'
      ;(step as any).meta = { ...(step as any).meta, server: (params as any)?.server, tool: (params as any)?.tool, result: (params as any)?.result }
      toolIndex.delete(callId)
      return
    }
    if (method === 'chat.tool.patch.begin') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (callId && toolIndex.has(callId)) return
      const p: any = params
      const files = p.files ?? 0
      const auto = p.autoApproved ? 'auto' : 'manual'
      const headPath = p.firstPath as any
      const adds = p.adds as any
      const dels = p.dels as any
      const name = typeof headPath === 'string' ? headPath.replace(/\/+$/g, '').split('/').pop() || headPath : undefined
      const addNum = typeof adds === 'number' ? adds : 0
      const delNum = typeof dels === 'number' ? dels : 0
      const extra = headPath && files > 1 ? ` (+${files - 1})` : ''
      const title = name ? `patch ${name}${extra}` : `patch ${files} files`
      const body = renderPatchDiff(p.changes, Number.POSITIVE_INFINITY as any, Number.POSITIVE_INFINITY as any)
      const step: TurnStep = { id: createId('patch'), kind: 'patch', title, status: 'streaming', ts: nowISO(), tags: [`+${addNum}-${delNum}`], meta: { files, autoApproved: p.autoApproved, firstPath: headPath, adds, dels, changes: p.changes }, body } as any
      t.steps.push(step)
      const stepIdx = t.steps.length - 1
      if (callId) toolIndex.set(callId, { turnIdx: tIndex, stepIdx })
      return
    }
    if (method === 'chat.tool.patch.end') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (callId && !toolIndex.has(callId)) return
      const idx = callId ? toolIndex.get(callId)! : { turnIdx: tIndex, stepIdx: turns[tIndex].steps.length - 1 }
      const step = turns[idx.turnIdx].steps[idx.stepIdx]
      step.status = (params as any)?.success ? 'completed' : 'failed'
      ;(step as any).meta = { ...(step as any).meta, success: (params as any)?.success, stdout: (params as any)?.stdout, stderr: (params as any)?.stderr }
      if (callId) toolIndex.delete(callId)
      return
    }
  })
}
