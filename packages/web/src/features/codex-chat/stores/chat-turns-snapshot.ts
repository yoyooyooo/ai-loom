import { createId } from '@/lib/id'
import type { Turn, TurnStep } from './chat-turns'
import { summarizeFirstLine, nowISO } from './chat-turns-utils'

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
    current.meta = { ...(current.meta || {}), working: false, workingTitle: 'Finished working' }
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
      steps: [],
      meta: { working: false, workingTitle: 'Finished working' }
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
      steps: [],
      meta: { working: true, workingTitle: 'Working' }
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
    if (target) {
      const still = target.steps.some((s) => s.status === 'streaming')
      target.meta = { ...(target.meta || {}), working: still, workingTitle: still ? 'Working' : 'Finished working' }
    }
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
        if (target) {
          target.status = 'failed' as any
          target.meta = { ...(target.meta || {}), working: false, workingTitle: 'Failed' }
        }
      } else if (method === 'chat.message.aborted') {
        if (target) {
          target.status = 'aborted' as any
          target.meta = { ...(target.meta || {}), working: false, workingTitle: 'Aborted' }
        }
      } else if (method === 'chat.message.completed') {
        if (target) {
          const text = typeof (params as any)?.text === 'string' ? String((params as any).text) : ''
          const existing = target.assistant?.text || ''
          target.assistant = { text: text || existing, ts: nowISO() }
          target.status = (target.status as any) === 'failed' || (target.status as any) === 'aborted' ? (target.status as any) : 'completed'
          const still = target.steps.some((s) => s.status === 'streaming')
          target.meta = { ...(target.meta || {}), working: still, workingTitle: still ? 'Working' : 'Finished working' }
        }
      }
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
        t.steps.push({ id: createId('thinking'), kind: 'thinking', title: title ? `thinking: ${title}` : 'thinking', body: text, status: 'completed', ts: nowISO(), meta: { thinking: true } } as any)
      }
      return
    }
    if (method === 'chat.tool.exec.begin') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId || toolIndex.has(callId)) return
      const command = Array.isArray((params as any)?.command) ? (params as any).command.map((item: any) => String(item)) : []
      const cwd = typeof (params as any)?.cwd === 'string' ? (params as any).cwd : undefined
      const step: TurnStep = { id: createId('exec'), kind: 'exec', title: `${command.join(' ')}${cwd ? ` (cwd=${cwd})` : ''}`, status: 'streaming', ts: nowISO(), meta: { command, cwd } } as any
      t.steps.push(step)
      const stepIdx = t.steps.length - 1
      toolIndex.set(callId, { turnIdx: tIndex, stepIdx })
      return
    }
    if (method === 'chat.tool.exec.output') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      const text = typeof (params as any)?.text === 'string' ? (params as any).text : ''
      if (!callId || !toolIndex.has(callId) || !text) return
      const idx = toolIndex.get(callId)!
      const step = turns[idx.turnIdx].steps[idx.stepIdx]
      step.body = (step.body || '') + text
      step.status = step.status === 'streaming' ? step.status : 'streaming'
      return
    }
    if (method === 'chat.tool.exec.end') {
      const callId = typeof (params as any)?.callId === 'string' ? (params as any).callId : undefined
      if (!callId || !toolIndex.has(callId)) return
      const idx = toolIndex.get(callId)!
      const step = turns[idx.turnIdx].steps[idx.stepIdx]
      step.status = 'completed'
      ;(step as any).meta = { ...(step as any).meta, exitCode: (params as any)?.exitCode, stdout: (params as any)?.stdout, stderr: (params as any)?.stderr }
      toolIndex.delete(callId)
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
      const head = headPath ? `${headPath} ${adds != null ? `+${adds}` : ''}${dels != null ? ` -${dels}` : ''}`.trim() : `${files} files`
      const extra = headPath && files > 1 ? ` (+${files - 1})` : ''
      const title = `[patch] ${head}${extra} (${auto})`
      const step: TurnStep = { id: createId('patch'), kind: 'patch', title, status: 'streaming', ts: nowISO(), meta: { files, autoApproved: p.autoApproved, firstPath: headPath, adds, dels, changes: p.changes } } as any
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
