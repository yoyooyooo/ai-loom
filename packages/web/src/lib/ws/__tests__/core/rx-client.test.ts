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
      (client as any).onMessage(
        JSON.stringify({ jsonrpc: '2.0', method, params: { eventId } })
      )

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
        { method: 'chat.message.delta', params: { conversationId: 'conv-x', eventId: 21, delta: 'hi' } },
        { method: 'chat.tool.exec.end', params: { conversationId: 'conv-x', eventId: 22, callId: 'c1' } }
      ],
      truncated: false
    }

    const callSpy = vi.fn(() =>
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
})
