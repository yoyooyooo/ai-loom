import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Observable } from 'rxjs'
import { WsRxClient } from '@/lib/ws/rx-client'

// 提供最小的 WebSocket 全局桩，避免真实连接
class FakeWS {
  url: string
  onopen: ((ev?: any) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  constructor(url: string) {
    this.url = url
    // 不主动触发 onopen，测试中不依赖实际连接
  }
  send(_txt: string) {}
  close() {}
  addEventListener(type: string, handler: any) {
    if (type === 'open') this.onopen = () => handler({})
    if (type === 'message') this.onmessage = (ev: any) => handler(ev)
    if (type === 'error') this.onerror = (ev: any) => handler(ev)
    if (type === 'close') this.onclose = (ev: any) => handler(ev)
  }
  removeEventListener(_type: string, _handler: any) {}
}

// @ts-ignore override global
globalThis.WebSocket = FakeWS as any

describe('WsRxClient eventId 去重与 resume 过滤', () => {
  let client: WsRxClient
  beforeEach(() => {
    client = new WsRxClient('ws://test')
  })

  it('对 codex/event/* 按 method#eventId 去重（旧帧/重复不触发）', () => {
    const seen: Array<{ method: string; params: any }> = []
    ;(client as any).events$.subscribe((ev: any) => seen.push(ev))

    const emit = (method: string, eventId: number) =>
      (client as any).onMessage(JSON.stringify({ jsonrpc: '2.0', method, params: { eventId } }))

    emit('codex/event/agent_message', 100)
    emit('codex/event/agent_message', 100) // 重复帧
    emit('codex/event/agent_message', 99) // 旧帧
    emit('codex/event/agent_message', 101) // 新帧

    // 仅两次有效发射：100 与 101
    const count = seen.filter((e) => e.method === 'codex/event/agent_message').length
    expect(count).toBe(2)
  })

  it('events.resume 仅补发 file/tree/annotations（跳过 chat.*）', async () => {
    const seen: string[] = []
    ;(client as any).events$.subscribe((ev: any) => seen.push(ev.method))

    // 替换 call 使 tryResume 可直接返回模拟结果
    const resumeResult = {
      events: [
        { method: 'chat.turn.started', params: { eventId: 1 } },
        { method: 'file.changed', params: { path: 'a', eventId: 2 } },
        { method: 'annotations.created', params: { ids: [1], eventId: 3 } },
        { method: 'tree.changed', params: { dir: '.', eventId: 4 } }
      ]
    }
    ;(client as any).call = () =>
      new Observable((sub) => {
        setTimeout(() => {
          sub.next(resumeResult)
          sub.complete()
        }, 0)
      })

    await (client as any).tryResume()

    expect(seen.includes('file.changed')).toBe(true)
    expect(seen.includes('annotations.created')).toBe(true)
    expect(seen.includes('tree.changed')).toBe(true)
    expect(seen.includes('chat.turn.started')).toBe(false)
  })

  it('chat.* 事件推进 convLast 并对重复 eventId 去重', () => {
    const seen: string[] = []
    ;(client as any).events$.subscribe((ev: any) => seen.push(ev.method))

    const payload = (eventId: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'chat.message.delta',
        params: { conversationId: 'conv-1', eventId, delta: `#${eventId}` }
      })

    ;(client as any).onMessage(payload(10))
    ;(client as any).onMessage(payload(10))
    ;(client as any).onMessage(payload(11))

    expect((client as any).convLast['conv-1']).toBe(11)
    const count = seen.filter((m) => m === 'chat.message.delta').length
    expect(count).toBe(2)
  })

  it('resumeChat 使用 topic chat 及 conversation 过滤并更新断点', async () => {
    const events: Array<{ method: string; params: any }> = []
    ;(client as any).events$.subscribe((ev: any) => events.push(ev))

    const resumeResult = {
      events: [
        {
          method: 'chat.message.delta',
          params: { conversationId: 'conv-x', eventId: 21, delta: 'hi' }
        },
        {
          method: 'chat.tool.exec.end',
          params: { conversationId: 'conv-x', eventId: 22, callId: 'c1' }
        }
      ],
      truncated: false
    }

    const callSpy = vi.fn(
      () =>
        new Observable((sub) => {
          sub.next(resumeResult)
          sub.complete()
        })
    )
    ;(client as any).call = callSpy

    await client.resumeChat('conv-x')

    expect(callSpy).toHaveBeenCalledTimes(1)
    const firstCall = (callSpy.mock.calls as any[])[0] ?? []
    const params = (firstCall[1] ?? {}) as any
    expect(params.topic).toBe('chat')
    expect(params.filter).toEqual({ conversationId: 'conv-x' })
    expect(params.tail).toBe(128)

    expect((client as any).convLast['conv-x']).toBe(22)
    const kinds = events.map((ev) => ev.method)
    expect(kinds).toEqual(['chat.message.delta', 'chat.tool.exec.end'])
  })

  it('resumeChatWithFilter 支持 providerId 过滤并使用 provider|conversation 游标键', async () => {
    const events: Array<{ method: string; params: any }> = []
    ;(client as any).events$.subscribe((ev: any) => events.push(ev))

    const resumeResult = {
      events: [
        {
          method: 'chat.message.delta',
          params: { conversationId: 'conv-p', provider: 'codex', eventId: 31, delta: 'hi' }
        },
        {
          method: 'chat.tool.exec.end',
          params: { conversationId: 'conv-p', provider: 'codex', eventId: 32, callId: 'c2' }
        }
      ],
      truncated: false
    }

    const callSpy = vi.fn(
      () =>
        new Observable((sub) => {
          sub.next(resumeResult)
          sub.complete()
        })
    )
    ;(client as any).call = callSpy

    await (client as any).resumeChatWithFilter('conv-p', 'codex')

    const firstCall = (callSpy.mock.calls as any[])[0] ?? []
    const params = (firstCall[1] ?? {}) as any
    expect(params.topic).toBe('chat')
    expect(params.filter).toEqual({ conversationId: 'conv-p', providerId: 'codex' })

    // provider|conversation key 形式推进
    expect((client as any).convLast['codex|conv-p']).toBe(32)
    expect(events.map((e) => e.method)).toEqual(['chat.message.delta', 'chat.tool.exec.end'])
  })

  it('resumeChat 优先使用“已应用游标”而非“已看到游标”作为 after', async () => {
    const seenParams: any[] = []
    const client2 = new WsRxClient('ws://test-2')
    // 伪造“已看到游标”领先
    ;(client2 as any).convLast['conv-applied'] = 50
    // 已应用仅到 20
    client2.primeConversationCursor('conv-applied', 20)

    // mock call 捕获入参
    const callSpy = vi.fn(
      (method: string, params?: any) =>
        new Observable((sub) => {
          seenParams.push(params)
          sub.next({ events: [], truncated: false })
          sub.complete()
        })
    )
    ;(client2 as any).call = callSpy

    await client2.resumeChat('conv-applied')

    expect(callSpy).toHaveBeenCalledTimes(1)
    const args = seenParams[0] || {}
    // after 应取 20（已应用），而不是 50（已看到）
    expect(args.after).toBe(20)
  })

  it('resumeChatWithFilter 在服务器重启导致 eventId 归零时夹取 after（min(local, serverCap)）', async () => {
    const client2 = new WsRxClient('ws://test-3')
    // 本地游标很大
    ;(client2 as any).convLast['conv-clamp'] = 100
    ;(client2 as any).convAppliedLast['conv-clamp'] = 90
    // 服务器 last_event_id 很小（重启后）
    ;(client2 as any).serverLastEventId = 30
    const prevVitest = (process as any).env?.VITEST
    ;(process as any).env.VITEST = '' // 关闭 Vitest 标志，触发 clamp 分支

    const seenParams: any[] = []
    const callSpy = vi.fn((method: string, params?: any) => {
      seenParams.push(params)
      return new Observable((sub) => {
        sub.next({ events: [], truncated: false })
        sub.complete()
      })
    })
    ;(client2 as any).call = callSpy

    await client2.resumeChat('conv-clamp')

    expect(callSpy).toHaveBeenCalledTimes(1)
    const p = seenParams[0] || {}
    expect(p.topic).toBe('chat')
    expect(p.filter).toEqual({ conversationId: 'conv-clamp' })
    // after 应被夹取到 serverLastEventId=30
    expect(p.after).toBe(30)
    // after>0 时不应带 tail
    expect('tail' in p).toBe(false)
    ;(process as any).env.VITEST = prevVitest
  })

  it('subscribeTopic$ 在服务器重启导致 eventId 归零时夹取 after（min(local, serverCap)）', async () => {
    const client3 = new WsRxClient('ws://test-4')
    ;(client3 as any).state = 'up' // 使 doSubscribe 立即执行
    ;(client3 as any).convLast['conv-sub'] = 99
    ;(client3 as any).serverLastEventId = 10
    const prevVitest = (process as any).env?.VITEST
    ;(process as any).env.VITEST = ''

    const seen: any[] = []
    const callSpy = vi.fn((method: string, params?: any) => {
      seen.push({ method, params })
      return new Observable((sub) => {
        sub.next({ ok: true })
        sub.complete()
      })
    })
    ;(client3 as any).call = callSpy

    const sub = (client3 as any)
      .subscribeTopic$('chat', { conversationId: 'conv-sub' })
      .subscribe(() => {})
    // 等待微任务结束
    await new Promise((r) => setTimeout(r, 0))
    sub.unsubscribe()

    expect(callSpy).toHaveBeenCalled()
    const subscribeParams = seen.find((item) => item.method === 'subscribe')?.params || {}
    expect(subscribeParams.topic).toBe('chat')
    expect(subscribeParams.filter).toEqual({ conversationId: 'conv-sub' })
    expect(subscribeParams.after).toBe(10) // clamp 到 serverLastEventId
    ;(process as any).env.VITEST = prevVitest
  })
})
