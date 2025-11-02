import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { toast } from 'sonner'

export function handleInfo(method: string, params: any) {
  switch (method) {
    case 'chat.info.user_message': {
      const txt = typeof params?.text === 'string' ? params.text : ''
      if (!txt) return true
      const ts = typeof params?.ts === 'string' ? params.ts : undefined
      const norm = (s: string) =>
        String(s || '')
          .replace(/\r/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store ? chatTurnSelectors.currentSlice(store) : undefined
        const turns: any[] = Array.isArray(slice?.turns) ? slice.turns : []
        let lastUserText: string | undefined
        for (let i = turns.length - 1; i >= 0; i--) {
          const turn = turns[i]
          if (turn?.user?.text) {
            lastUserText = String(turn.user.text)
            break
          }
        }
        const isDup = norm(lastUserText || '') === norm(txt)
        // 若最后一轮已完成且助手正文存在，且用户消息等价，则视为握手补发，忽略
        const last = turns.length > 0 ? turns[turns.length - 1] : undefined
        const lastCompletedWithAssistant =
          !!last && last.status === 'completed' && String(last?.assistant?.text || '').trim()
        if (isDup && lastCompletedWithAssistant) return true
        if (!isDup) {
          chatTurnActions.markTurnStarted({ startedAt: ts })
          chatTurnActions.setUserText(txt)
        }
      } catch {
        chatTurnActions.markTurnStarted({ startedAt: ts })
        chatTurnActions.setUserText(txt)
      }
      return true
    }
    case 'chat.info.plan_update': {
      const plan = Array.isArray(params?.plan) ? params.plan : []
      const explanation = typeof params?.explanation === 'string' ? params.explanation : ''
      const title = explanation ? `Plan 更新：${explanation}` : 'Plan 更新'
      const normalized = plan.map((step: any, idx: number) => {
        const rawStatus = typeof step?.status === 'string' ? step.status : ''
        const statusLower = rawStatus.trim().toLowerCase()
        const normalizedStatus = (() => {
          if (['completed', 'complete', 'done'].includes(statusLower)) return 'completed'
          if (['in_progress', 'in-progress', 'working'].includes(statusLower)) return 'in_progress'
          if (['pending', 'todo', 'not_started'].includes(statusLower)) return 'pending'
          return statusLower || 'unknown'
        })()
        const text = typeof step?.step === 'string' ? step.step : `Step ${idx + 1}`
        return { step: text, status: normalizedStatus }
      })
      const lines = normalized
        .map(({ step: text, status }: { step: string; status: string }) => {
          const mark = status === 'completed' ? '✔' : status === 'in_progress' ? '…' : '·'
          return `${mark} ${text}`
        })
        .join('\n')
      const body = lines
      const hasOngoing = normalized.some((it: any) => it.status !== 'completed')
      const stepStatus = hasOngoing ? 'streaming' : 'completed'
      const PLAN_CALL_ID = '__plan_update__'
      chatTurnActions.addStep('plan', PLAN_CALL_ID, title, {
        status: stepStatus,
        body,
        meta: { plan: normalized }
      })
      return true
    }
    case 'chat.info.approval.exec': {
      const cmd = Array.isArray(params?.command) ? params.command.join(' ') : ''
      const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
      const reason = typeof params?.reason === 'string' ? params.reason : ''
      const summary = [`[审批请求] 执行命令 ${cmd || '(unknown)'}（已自动批准）`]
      if (cwd) summary.push(`cwd=${cwd}`)
      if (reason) summary.push(`理由：${reason}`)
      chatTurnActions.addInfo(summary.join('\n'))
      return true
    }
    case 'chat.info.approval.patch': {
      const count = typeof params?.changeCount === 'number' ? params.changeCount : undefined
      const reason = typeof params?.reason === 'string' ? params.reason : ''
      const grant = typeof params?.grantRoot === 'string' ? params.grantRoot : ''
      const summary = [
        `[审批请求] 应用补丁${count != null ? ` (${count} files)` : ''}（已自动批准）`
      ]
      if (reason) summary.push(`理由：${reason}`)
      if (grant) summary.push(`请求写入根：${grant}`)
      chatTurnActions.addInfo(summary.join('\n'))
      return true
    }
    case 'chat.info.background': {
      const message = typeof params?.message === 'string' ? params.message : ''
      const code = typeof params?.code === 'string' ? params.code : ''
      if (code === 'engine_swapped') {
        toast.success('已强制停止，并热切换新引擎恢复其他活跃会话')
      } else if (message) {
        chatTurnActions.addInfo(`[系统] ${message}`)
      }
      return true
    }
    case 'chat.info.web_search.begin': {
      chatTurnActions.addInfo('[web-search] 开始检索…')
      return true
    }
    case 'chat.info.web_search.end': {
      const q = typeof params?.query === 'string' ? params.query : ''
      chatTurnActions.addInfo(`[web-search] 完成${q ? `：${q}` : ''}`)
      return true
    }
    case 'chat.info.view_image': {
      const path = typeof params?.path === 'string' ? params.path : ''
      chatTurnActions.addInfo(`[view-image] ${path}`)
      return true
    }
    case 'chat.info.conversation_path': {
      const path = typeof params?.path === 'string' ? params.path : ''
      if (path) chatTurnActions.addInfo(`[rollout] ${path}`)
      return true
    }
    case 'chat.info.review.entered': {
      chatTurnActions.addInfo('[review] 进入审查模式')
      return true
    }
    case 'chat.info.review.exited': {
      chatTurnActions.addInfo('[review] 退出审查模式')
      return true
    }
  }
  return false
}
