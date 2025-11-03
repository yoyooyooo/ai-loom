import { describe, it, expect } from 'vitest'
import { Subject } from 'rxjs'
import { buildCodexPipeline } from '@/features/codex-chat/services/ws-pipeline-codex'

describe('ws-pipeline-codex', () => {
  it('splits codex events into dedicated streams', () => {
    const source$$ = new Subject<{ method: string; params: any }>()
    const { sessionConfigured$, authStatusChange$, rateLimitUpdated$ } = buildCodexPipeline(
      source$$.asObservable()
    )
    const seen: string[] = []
    const s1 = sessionConfigured$.subscribe(() => seen.push('configured'))
    const s2 = authStatusChange$.subscribe(() => seen.push('auth'))
    const s3 = rateLimitUpdated$.subscribe(() => seen.push('limits'))

    source$$.next({ method: 'codex/sessionConfigured', params: { conversationId: 'X' } })
    source$$.next({ method: 'codex/authStatusChange', params: { authenticated: true } })
    source$$.next({ method: 'codex/account/rateLimits/updated', params: { remaining: 1 } })

    expect(new Set(seen)).toEqual(new Set(['configured', 'auth', 'limits']))

    s1.unsubscribe()
    s2.unsubscribe()
    s3.unsubscribe()
  })
})
