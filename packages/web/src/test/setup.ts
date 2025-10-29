import { beforeAll, afterAll, afterEach, vi } from 'vitest'
import { server } from './msw.server'

// jsdom 环境中有时区/时间相关差异，这里不做全局 polyfill，仅启动 MSW

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
