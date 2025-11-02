import { Observable } from 'rxjs'
import { filter, map, share } from 'rxjs/operators'

export type WsEvent = { method: string; params: any }

export function buildCodexPipeline(events$: Observable<WsEvent>) {
  const source$ = events$.pipe(share())
  const is = (m: string) => (ev: WsEvent) => ev.method === m
  const pick = (m: string) =>
    source$.pipe(
      filter(is(m)),
      map((ev) => ev.params)
    )

  return {
    sessionConfigured$: pick('codex/sessionConfigured'),
    authStatusChange$: pick('codex/authStatusChange'),
    rateLimitUpdated$: pick('codex/account/rateLimits/updated')
  }
}
