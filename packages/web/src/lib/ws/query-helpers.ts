import { ws } from './singleton'

const DEFAULT_TIMEOUT_MS = (() => {
  const v = (import.meta as any).env?.VITE_WS_TIMEOUT_MS
  const n = v ? parseInt(String(v), 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 15000
})()
const DEFAULT_FUSE_MS = (() => {
  const v = (import.meta as any).env?.VITE_WS_FUSE_MS
  const n = v ? parseInt(String(v), 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : 1500
})()

const NO_FALLBACK = (() => {
  const v = (import.meta as any).env?.VITE_WS_NO_FALLBACK
  if (v == null) return false
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true'
})()

const DEBUG_ROUTE = (() => {
  const v = (import.meta as any).env?.VITE_WS_DEBUG_ROUTE
  if (v == null) return false
  const s = String(v).toLowerCase()
  return s === '1' || s === 'true'
})()

const isTransportError = (e: any) => {
  const code = e?.code
  if (!code) return true
  return (
    code === 'MESSAGE_TOO_LARGE' ||
    code === 'WS_DOWN' ||
    code === 'TIMEOUT' ||
    code === 'WS_DISABLED' ||
    code === 'NOT_SUPPORTED'
  )
}

// 短窗熔断：某方法发生传输类错误后，在 fuseMs 窗口内直接回退 REST，避免抖动
const fuseUntil = new Map<string, number>()

export async function wsPrefer<T>(
  method: string,
  params: any,
  httpFallback: (signal?: AbortSignal) => Promise<T>,
  opts?: { timeoutMs?: number; fuseMs?: number; signal?: AbortSignal }
): Promise<T> {
  try {
    if (!ws.enabled) throw Object.assign(new Error('WS_DISABLED'), { code: 'WS_DISABLED' })
    // no-fallback 模式下，为避免首批调用撞在 connecting 上导致 WS_DOWN，先短暂等待 WS 就绪
    if (NO_FALLBACK && (ws as any).state !== 'up') {
      await waitForWsUp(Math.min(1000, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS))
    }
    // fuse 窗口检查
    const now = Date.now()
    const until = fuseUntil.get(method) || 0
    // 在 no-fallback 模式下忽略 fuse，持续尝试 WS
    if (!NO_FALLBACK && now < until) {
      if (DEBUG_ROUTE) console.log('[wsPrefer] REST(fuse)', method)
      return await httpFallback(opts?.signal)
    }
    const ms = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (DEBUG_ROUTE) console.log('[wsPrefer] WS', method)
    return await ws.callOnce<T>(method, params, ms)
  } catch (e: any) {
    if (!isTransportError(e)) throw e
    // 命中传输/能力错误：设置 fuse 窗口
    const fuseMs = opts?.fuseMs ?? DEFAULT_FUSE_MS
    if (!NO_FALLBACK && fuseMs > 0) fuseUntil.set(method, Date.now() + fuseMs)
    if (NO_FALLBACK) {
      if (DEBUG_ROUTE) console.log('[wsPrefer] WS(error, no-fallback)', method, e?.code || e)
      throw e
    }
    if (DEBUG_ROUTE) console.log('[wsPrefer] REST(error)', method, e?.code || e)
    return await httpFallback(opts?.signal)
  }
}

function waitForWsUp(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    try {
      if ((ws as any).state === 'up') {
        resolve()
        return
      }
      let done = false
      const timer = setTimeout(
        () => {
          if (!done) {
            done = true
            try {
              sub?.unsubscribe?.()
            } catch {}
            resolve()
          }
        },
        Math.max(0, timeoutMs || 0)
      )
      const sub = (ws as any).online$?.subscribe?.((v: any) => {
        if (done) return
        if (v) {
          done = true
          clearTimeout(timer)
          try {
            sub?.unsubscribe?.()
          } catch {}
          resolve()
        }
      })
    } catch {
      resolve()
    }
  })
}
