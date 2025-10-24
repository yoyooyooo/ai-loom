import { chatTurnActions, useChatTurnStore } from '../stores/chat-turns'
import { parseExploreActions } from '@/features/codex-chat/utils/explore-utils'
import { createId } from '@/lib/id'
import { renderPatchDiff } from './ws-render-utils'

type ProcessOptions = {
  useRxDelta: boolean
  aggregateTools: boolean
  keepToolStream: boolean
  patchMaxFiles: number
  patchMaxChars: number
}

export function createProcessChatEvent(opts: ProcessOptions) {
  const { useRxDelta, patchMaxFiles: PATCH_MAX_FILES, patchMaxChars: PATCH_MAX_CHARS } = opts

  return function processChatEvent(method: string, params: any) {
    switch (method) {
      case 'chat.session.new':
      case 'chat.session.resumed': {
        const id = typeof params.conversationId === 'string' ? params.conversationId : ''
        if (id) chatTurnActions.setConversationId(id)
        break
      }
      case 'chat.session.history': {
        const history = Array.isArray((params as any)?.messages) ? ((params as any).messages ?? []) : []
        // 仅当本地尚未有 turns 时才用 WS 的 history 进行填充，避免覆盖 resume/loadSnapshot 已写入的 steps
        try {
          const st: any = (useChatTurnStore as any).getState?.()
          const hasTurns = Array.isArray(st?.turns) && st.turns.length > 0
          if (!hasTurns && history.length > 0) chatTurnActions.loadFromHistory(history)
        } catch {
          if (history.length > 0) chatTurnActions.loadFromHistory(history)
        }
        break
      }
      case 'chat.turn.started': {
        chatTurnActions.markTurnStarted({ startedAt: typeof params.startedAt === 'string' ? params.startedAt : undefined })
        break
      }
      case 'chat.message.delta': {
        if (useRxDelta) break
        const delta = params.delta ?? ''
        if (typeof delta === 'string' && delta) {
          try {
            const st: any = (useChatTurnStore as any).getState?.()
            const hasTurns = Array.isArray(st?.turns) && st.turns.length > 0
            if (!hasTurns) chatTurnActions.markTurnStarted({})
          } catch {}
          chatTurnActions.appendAssistantDelta(delta)
        }
        break
      }
      case 'chat.message.completed': {
        const text = typeof params.text === 'string' ? params.text : undefined
        chatTurnActions.completeAssistant(text)
        // 特殊：Compact task completed 高亮标记
        const isCompactDone = (text || '').trim().toLowerCase() === 'compact task completed'
        if (isCompactDone) {
          chatTurnActions.addStep('info', undefined, '[Compact] 任务完成', { status: 'completed', meta: { compactDone: true } })
        }
        break
      }
      case 'chat.message.failed': {
        const msg = params?.error?.message || '生成失败'
        chatTurnActions.failAssistant(msg)
        chatTurnActions.completeTurn()
        break
      }
      case 'chat.message.aborted': {
        chatTurnActions.abortAssistant()
        chatTurnActions.completeTurn()
        break
      }
      case 'chat.reasoning.delta': {
        if (useRxDelta) break
        const delta = typeof params.delta === 'string' ? params.delta : ''
        if (delta) chatTurnActions.appendReasoning(delta)
        break
      }
      case 'chat.reasoning.end': {
        const text = typeof params.text === 'string' ? params.text : ''
        chatTurnActions.endReasoning(text)
        // 去重：若该轮已有相同 thinking 步骤则跳过
        try {
          const st: any = (useChatTurnStore as any).getState?.()
          const turns: any[] = Array.isArray(st?.turns) ? st.turns : []
          const active = turns[turns.length - 1]
          const dup = !!active?.steps?.some((s: any) => s?.kind === 'thinking' && String(s?.body || '') === text)
          if (!dup && text) {
            const first = String(text || '').replace(/\r/g, '').split(/\n/).find((ln) => ln.trim().length > 0) || ''
            const cleaned = first.replace(/^[\s#>*_`]+/, '').replace(/[\s#*_`]+$/, '').trim()
            const title = cleaned ? `thinking: ${cleaned}` : 'thinking'
            chatTurnActions.addStep('thinking', undefined, title, { status: 'completed', body: text, meta: { thinking: true } })
          }
        } catch {
          // 忽略
        }
        break
      }
      case 'chat.reasoning.section_break': {
        chatTurnActions.appendReasoning('\n---\n')
        break
      }
      // Exec tool
      case 'chat.tool.exec.begin': {
        const command = Array.isArray(params.command) ? params.command.map(String) : []
        const cmdStr = command.join(' ')
        const cwd = typeof params.cwd === 'string' ? params.cwd : ''
        const callId = typeof params.callId === 'string' ? params.callId : createId('exec')
        const acts = parseExploreActions(command, cwd)
        if (acts.length > 0) {
          for (const action of acts) {
            if (action.kind === 'read') {
              const path = action.path
              const name = path.replace(/\/+$|\/+$/g, '').split('/').pop() || path
              const title = `Read ${name} (lines: ${action.start}-${action.end})`
              chatTurnActions.addStep('read', undefined, title, {
                meta: { file: path, start: action.start, end: action.end },
                tags: [name],
                status: 'completed'
              })
            } else if (action.kind === 'list') {
              const target = action.target ? String(action.target).replace(/\/+$|\/+$/g, '') : undefined
              const name = target ? target.split('/').pop() || target : undefined
              const title = name ? `${action.label} ${name}` : action.label
              chatTurnActions.addStep('list', undefined, title, {
                tags: name ? [name] : undefined,
                status: 'completed'
              })
            } else if (action.kind === 'search') {
              const target = action.target ? String(action.target).replace(/\/+$|\/+$/g, '') : undefined
              const name = target ? target.split('/').pop() || target : undefined
              const base = `Search ${String((action as any).query)}`
              const title = name ? `${base} in ${name}` : base
              chatTurnActions.addStep('search', undefined, title, {
                tags: name ? [name] : undefined,
                status: 'completed'
              })
            }
          }
        }
        const title = `${cmdStr}${cwd ? ` (cwd=${cwd})` : ''}`
        chatTurnActions.addStep('exec', callId, title, { meta: { command, cwd } })
        break
      }
      case 'chat.tool.exec.output': {
        const line = typeof params.text === 'string' ? params.text : typeof params.chunk === 'string' ? params.chunk : ''
        if (!line) break
        const callId = typeof params.callId === 'string' ? params.callId : undefined
        if (!callId) break
        chatTurnActions.appendStep(callId, line)
        break
      }
      case 'chat.tool.exec.end': {
        const code = params.exitCode
        const callId = typeof params.callId === 'string' ? params.callId : undefined
        if (callId) chatTurnActions.endStep(callId, { status: 'completed', meta: { exitCode: code, stdout: params.stdout, stderr: params.stderr } })
        break
      }
      // Patch tool
      case 'chat.tool.patch.begin': {
        const p = params as any
        const files = p.files ?? 0
        const callId = typeof p.callId === 'string' ? p.callId : createId('patch')
        const auto = p.autoApproved ? 'auto' : 'manual'
        const headPath = p.firstPath as any
        const adds = p.adds as any
        const dels = p.dels as any
        const head = headPath ? `${headPath} ${adds != null ? `+${adds}` : ''}${dels != null ? ` -${dels}` : ''}`.trim() : `${files} files`
        const extra = headPath && files > 1 ? ` (+${files - 1})` : ''
        const title = `[patch] ${head}${extra} (${auto})`
        const changes = p.changes as any
        // 暂不渲染 diff 正文；后续用 diff editor 替代
        chatTurnActions.addStep('patch', callId, title, { meta: { files, autoApproved: p.autoApproved, firstPath: headPath, adds, dels, changes } })
        break
      }
      case 'chat.tool.patch.end': {
        const ok = params.success
        const callId = typeof params.callId === 'string' ? params.callId : undefined
        if (callId) chatTurnActions.endStep(callId, { status: ok ? 'completed' : 'failed', meta: { success: ok, stdout: params.stdout, stderr: params.stderr } })
        break
      }
      // MCP
      case 'chat.tool.mcp.begin': {
        const server = typeof params.server === 'string' ? params.server : ''
        const tool = typeof params.tool === 'string' ? params.tool : ''
        const args = params.arguments
        const callId = typeof params.callId === 'string' ? params.callId : createId('mcp')
        const title = server || tool ? `${server}${server && tool ? '/' : ''}${tool}` : 'mcp'
        chatTurnActions.addStep('mcp', callId, title, { meta: { server, tool, args } })
        break
      }
      case 'chat.tool.mcp.end': {
        const server = typeof params.server === 'string' ? params.server : ''
        const tool = typeof params.tool === 'string' ? params.tool : ''
        const res = params.result
        const callId = typeof params.callId === 'string' ? params.callId : undefined
        if (callId) chatTurnActions.endStep(callId, { status: 'completed', meta: { server, tool, result: res } })
        break
      }
      // Info / turn
      case 'chat.info.user_message': {
        const txt = typeof params.text === 'string' ? params.text : ''
        if (!txt) break
        try {
          const st: any = (useChatTurnStore as any).getState?.()
          const turns: any[] = Array.isArray(st?.turns) ? st.turns : []
          let lastUserText: string | undefined
          for (let i = turns.length - 1; i >= 0; i--) {
            const turn = turns[i]
            if (turn?.user?.text) { lastUserText = String(turn.user.text); break }
          }
          const isDuplicateUser = (lastUserText || '') === txt
          if (!isDuplicateUser) {
            chatTurnActions.markTurnStarted({})
            chatTurnActions.setUserText(txt)
          }
        } catch {
          chatTurnActions.markTurnStarted({})
          chatTurnActions.setUserText(txt)
        }
        break
      }
      case 'chat.info.turn_diff': {
        const diff = typeof params.diff === 'string' ? params.diff : ''
        if (diff) {
          const body = `Turn diff 更新:\n\n\`\`\`diff\n${diff}\n\`\`\``
          chatTurnActions.addInfo(body)
        }
        break
      }
      case 'chat.info.plan_update': {
        const plan = Array.isArray(params.plan) ? params.plan : []
        const explanation = typeof params.explanation === 'string' ? params.explanation : ''
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
        // 使用 plan 类型的 step，样式凸显
        chatTurnActions.addStep('plan', undefined, title, { status: 'completed', body, meta: { plan } })
        break
      }
      case 'chat.info.approval.exec': {
        const cmd = Array.isArray(params.command) ? params.command.join(' ') : ''
        const cwd = typeof params.cwd === 'string' ? params.cwd : ''
        const reason = typeof params.reason === 'string' ? params.reason : ''
        const summary = [`[审批请求] 执行命令 ${cmd || '(unknown)'}（已自动批准）`]
        if (cwd) summary.push(`cwd=${cwd}`)
        if (reason) summary.push(`理由：${reason}`)
        chatTurnActions.addInfo(summary.join('\n'))
        break
      }
      case 'chat.info.approval.patch': {
        const count = typeof params.changeCount === 'number' ? params.changeCount : undefined
        const reason = typeof params.reason === 'string' ? params.reason : ''
        const grant = typeof params.grantRoot === 'string' ? params.grantRoot : ''
        const summary = [`[审批请求] 应用补丁${count != null ? ` (${count} files)` : ''}（已自动批准）`]
        if (reason) summary.push(`理由：${reason}`)
        if (grant) summary.push(`请求写入根：${grant}`)
        chatTurnActions.addInfo(summary.join('\n'))
        break
      }
      case 'chat.info.background': {
        const message = typeof params.message === 'string' ? params.message : ''
        if (message) {
          chatTurnActions.addInfo(`[系统] ${message}`)
        }
        break
      }
      case 'chat.info.web_search.begin': {
        chatTurnActions.addInfo('[web-search] 开始检索…')
        break
      }
      case 'chat.info.web_search.end': {
        const q = typeof params.query === 'string' ? params.query : ''
        chatTurnActions.addInfo(`[web-search] 完成${q ? `：${q}` : ''}`)
        break
      }
      case 'chat.info.view_image': {
        const path = typeof params.path === 'string' ? params.path : ''
        chatTurnActions.addInfo(`[view-image] ${path}`)
        break
      }
      case 'chat.info.conversation_path': {
        const path = typeof params.path === 'string' ? params.path : ''
        if (path) {
          chatTurnActions.addInfo(`[rollout] ${path}`)
        }
        break
      }
      case 'chat.info.review.entered': {
        chatTurnActions.addInfo('[review] 进入审查模式')
        break
      }
      case 'chat.info.review.exited': {
        chatTurnActions.addInfo('[review] 退出审查模式')
        break
      }
      case 'chat.turn.complete': {
        chatTurnActions.completeTurn()
        break
      }
      default: {
        // no-op
      }
    }
  }
}
