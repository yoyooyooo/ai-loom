import { handleSession } from './session'
import { handleMessage } from './message'
import { handleReasoning } from './reasoning'
import { handleTurn } from './turn'
import { handleTools } from './tools'
import { handleInfo } from './info'

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
    // 1) session 类
    if (handleSession(method, params)) return
    // 2) message 类
    if (handleMessage(method, params, { useRxDelta })) return
    // 3) reasoning 类
    if (handleReasoning(method, params, { useRxDelta })) return
    // 4) turn 边界事件
    if (handleTurn(method, params)) return
    // 5) 工具与信息类
    if (
      handleTools(method, params, {
        patchMaxFiles: PATCH_MAX_FILES,
        patchMaxChars: PATCH_MAX_CHARS
      })
    )
      return
    if (handleInfo(method, params)) return
    // 未识别事件：忽略（保留可扩展空间）
  }
}
