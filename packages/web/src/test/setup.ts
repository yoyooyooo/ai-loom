import { beforeAll, afterAll, afterEach, vi } from 'vitest'
import { server } from './msw.server'

// jsdom 环境中有时区/时间相关差异，这里不做全局 polyfill，仅启动 MSW

// Polyfill: ResizeObserver（用于 UI 组件在 JSDOM 环境下不报错）
if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// 默认关闭“隐藏非 patch 输出”，以便测试观察到完整文本
vi.stubEnv('VITE_CHAT_HIDE_NONPATCH_OUTPUTS', '0')
if (typeof (import.meta as any).env !== 'object') {
  ;(import.meta as any).env = {}
}
;(import.meta as any).env.VITE_CHAT_HIDE_NONPATCH_OUTPUTS = '0'

beforeAll(() => {
  // 忽略未匹配的 WebSocket（ws:// / wss://），其余保持 error 以避免静默网络出站
  server.listen({
    onUnhandledRequest(req, print) {
      const url = req.url || ''
      if (url.startsWith('ws://') || url.startsWith('wss://')) return
      print.error()
    }
  })
})

afterEach(() => {
  server.resetHandlers()
  vi.restoreAllMocks()
})

afterAll(() => {
  server.close()
})
