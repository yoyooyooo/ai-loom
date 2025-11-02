import { chatTurnActions, useChatTurnStore, chatTurnSelectors } from '../../stores/chat-turns'
import { parseExploreActions } from '@/features/codex-chat/utils/explore-utils'
import { createId } from '@/lib/id'
import { renderPatchDiff } from '../ws-render-utils'
import {
  buildExecFallbackStepParts,
  buildPatchToolBeginParts,
  buildPatchFromApplyPatchCommand,
  buildMcpBeginParts,
  buildMcpEndMeta,
  buildReadStepParts,
  buildListStepParts,
  buildSearchStepParts
} from '../ws-step-builders'

export function handleTools(
  method: string,
  params: any,
  opts: { useRxDelta?: boolean; patchMaxFiles: number; patchMaxChars: number }
) {
  switch (method) {
    // Exec tool
    case 'chat.tool.exec.begin': {
      // 若当前没有活跃 turn，则隐式开启一轮，避免步骤写入已完成的上一轮
      try {
        const store: any = (useChatTurnStore as any).getState?.()
        const slice = store ? chatTurnSelectors.currentSlice(store) : undefined
        const active = slice?.activeTurnId
        const turns = Array.isArray(slice?.turns) ? slice.turns : []
        const last = turns.length > 0 ? turns[turns.length - 1] : undefined
        const hasStreaming = !!(last && last.status === 'streaming')
        if (!active && !hasStreaming) chatTurnActions.markTurnStarted({})
      } catch {
        chatTurnActions.markTurnStarted({})
      }
      const command = Array.isArray(params?.command) ? params.command.map(String) : []
      const cmdStr = command.join(' ')
      const cwd = typeof params?.cwd === 'string' ? params.cwd : ''
      const callId = typeof params?.callId === 'string' ? params.callId : createId('exec')
      const acts = parseExploreActions(command, cwd)
      if (acts.length > 0) {
        // 仅针对 search 在同一条 exec.begin 中做轻量去重（query + target）
        const seenSearch = new Set<string>()
        let first = true
        for (const a of acts) {
          if (a.kind === 'read') {
            const p = buildReadStepParts(a as any, { command, cwd, callId })
            chatTurnActions.addStep('read', first ? callId : undefined, p.title, {
              status: 'completed',
              meta: p.meta,
              tags: p.tags
            })
            first = false
            continue
          }
          if (a.kind === 'list') {
            const p = buildListStepParts(a as any, { command, cwd, callId })
            chatTurnActions.addStep('list', first ? callId : undefined, p.title, {
              status: 'completed',
              meta: p.meta,
              tags: p.tags
            })
            first = false
            continue
          }
          if (a.kind === 'search') {
            const key = `${(a as any).query || ''}||${(a as any).target || ''}`
            if (seenSearch.has(key)) continue
            seenSearch.add(key)
            const p = buildSearchStepParts(a as any, { command, cwd, callId })
            chatTurnActions.addStep('search', first ? callId : undefined, p.title, {
              status: 'completed',
              meta: p.meta,
              tags: p.tags
            })
            first = false
            continue
          }
          const r = buildExecFallbackStepParts({ command, cwd, callId })
          chatTurnActions.addStep('exec', first ? callId : undefined, r.title, { meta: r.meta })
          first = false
        }
      } else {
        const src = command.join('\n')
        const isApplyPatch =
          /apply_patch|applypatch|git\s+apply/i.test(src) || /\*\*\*\s+Begin Patch/.test(src)
        if (isApplyPatch) {
          // 识别 apply_patch 补丁块，直接作为 patch 卡片展示
          const r = buildPatchFromApplyPatchCommand({ command, cwd, callId })
          chatTurnActions.addStep('patch', callId, r.title, { body: r.body || '', meta: r.meta })
        } else {
          const r = buildExecFallbackStepParts({ command, cwd, callId })
          chatTurnActions.addStep('exec', callId, r.title, { meta: r.meta })
        }
      }
      return true
    }
    case 'chat.tool.exec.output': {
      if (opts.useRxDelta) return true
      const text =
        typeof params?.text === 'string'
          ? params.text
          : typeof params?.chunk === 'string'
            ? params.chunk
            : ''
      const callId = typeof params?.callId === 'string' ? params.callId : undefined
      if (!text || !callId) return true
      chatTurnActions.appendStep(callId, text)
      return true
    }
    case 'chat.tool.exec.end': {
      const callId = typeof params?.callId === 'string' ? params.callId : undefined
      const code = params?.exitCode
      if (callId)
        chatTurnActions.endStep(callId, {
          status: 'completed',
          meta: { exitCode: code, stdout: params?.stdout, stderr: params?.stderr }
        })
      return true
    }

    // Patch tool
    case 'chat.tool.patch.begin': {
      const callId = typeof params?.callId === 'string' ? params.callId : createId('patch')
      const r = buildPatchToolBeginParts(
        params || {},
        { patchMaxFiles: opts.patchMaxFiles, patchMaxChars: opts.patchMaxChars },
        callId
      )
      chatTurnActions.addStep('patch', callId, r.title, {
        body: r.body,
        meta: r.meta
      })
      return true
    }
    case 'chat.tool.patch.end': {
      const callId = typeof params?.callId === 'string' ? params.callId : undefined
      const ok = !!params?.success
      if (callId)
        chatTurnActions.endStep(callId, {
          status: ok ? 'completed' : 'failed',
          meta: { patch: { success: ok }, stdout: params?.stdout, stderr: params?.stderr }
        })
      return true
    }

    // MCP tool
    case 'chat.tool.mcp.begin': {
      const callId = typeof params?.callId === 'string' ? params.callId : createId('mcp')
      const r = buildMcpBeginParts(
        { server: params?.server, tool: params?.tool, args: params?.arguments },
        callId
      )
      chatTurnActions.addStep('mcp', callId, r.title, { meta: r.meta })
      return true
    }
    case 'chat.tool.mcp.end': {
      const callId = typeof params?.callId === 'string' ? params.callId : undefined
      if (callId)
        chatTurnActions.endStep(callId, {
          status: 'completed',
          meta: buildMcpEndMeta({
            server: params?.server,
            tool: params?.tool,
            result: params?.result
          })
        })
      return true
    }
  }
  return false
}
