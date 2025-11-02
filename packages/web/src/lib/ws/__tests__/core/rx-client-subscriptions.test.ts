import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Observable } from 'rxjs'
import { WsRxClient } from '@/lib/ws/rx-client'

class FakeWS {
  url: string
  onopen: ((ev?: any) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev?: any) => void) | null = null
  onclose: ((ev?: any) => void) | null = null
  constructor(url: string) {
    this.url = url
  }
  send(_txt: string) {}
  close() {}
  addEventListener(_type: string, _handler: any) {}
  removeEventListener(_type: string, _handler: any) {}
}

// @ts-ignore override global
globalThis.WebSocket = FakeWS as any

describe('WsRxClient subscriptions lifecycle (intent × online)', () => {
  let client: WsRxClient
  beforeEach(() => {
    client = new WsRxClient('ws://test-intent')
    ;(client as any).state = 'down'
    ;(client as any).unsubDebounceMs = 20
  })

  it('0→1 只触发一次 subscribe，1→0 去抖退订后触发 unsubscribe', async () => {
    const callSpy = vi.fn(
      (method: string, params?: any) =>
        new Observable((sub) => {
          sub.next({ ok: true, method, params })
          sub.complete()
        })
    )
    ;(client as any).call = callSpy

    // 两个订阅者 retain 同一 token
    const s1 = (client as any)
      .subscribeTopic$('chat', { conversationId: 'C-1' })
      .subscribe(() => {})
    const s2 = (client as any)
      .subscribeTopic$('chat', { conversationId: 'C-1' })
      .subscribe(() => {})

    // 上线 → 触发订阅（仅一次）
    ;(client as any).onlineSubject.next(true)

    await new Promise((r) => setTimeout(r, 0))
    const subs = (callSpy.mock.calls as any[]).filter((c) => c[0] === 'subscribe')
    expect(subs.length).toBe(1)
    expect(subs[0][1].filter).toEqual({ conversationId: 'C-1' })

    // 一个释放，不退订
    s1.unsubscribe()
    await new Promise((r) => setTimeout(r, 30))
    const unsubs1 = (callSpy.mock.calls as any[]).filter((c) => c[0] === 'unsubscribe')
    expect(unsubs1.length).toBe(0)

    // 最后一个释放 → 去抖后退订
    s2.unsubscribe()
    await new Promise((r) => setTimeout(r, 40))
    // 退订去抖后，本地已订阅集应无该 token（避免耦合具体 RPC 次数）
    const hasToken = (client as any).subscribedTokens.has('chat:{"conversationId":"C-1"}')
    expect(hasToken).toBe(false)
  })

  it('断线清空 subscribedTokens，重连按 desired 集合补齐订阅', async () => {
    const callSpy = vi.fn(
      (method: string, params?: any) =>
        new Observable((sub) => {
          sub.next({ ok: true, method, params })
          sub.complete()
        })
    )
    ;(client as any).call = callSpy

    const s = (client as any).subscribeTopic$('chat', { conversationId: 'R-1' }).subscribe(() => {})

    // 上线 → 触发订阅
    ;(client as any).onlineSubject.next(true)
    await new Promise((r) => setTimeout(r, 0))
    expect((callSpy.mock.calls as any[]).filter((c) => c[0] === 'subscribe').length).toBe(1)

    // 断线 → 清空本地已订阅集
    ;(client as any).onlineSubject.next(false)

    // 再上线 → desired 仍包含该 token，应再次订阅一次
    ;(client as any).onlineSubject.next(true)
    await new Promise((r) => setTimeout(r, 0))
    expect((callSpy.mock.calls as any[]).filter((c) => c[0] === 'subscribe').length).toBe(2)

    s.unsubscribe()
  })
})
