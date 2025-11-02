import { useEffect, useRef, useState } from 'react'
import { ws } from './singleton'
import { computeDelta, updateSeries } from './stats-utils'
import { useChatTurnStore } from '@/features/codex-chat/stores/chat-turns'

export function WsDebugPanel() {
  // 仅在显式开启调试时挂载逻辑，避免无谓的 session.info 采样与日志噪音
  const enabled = Boolean((import.meta as any).env?.VITE_WS_DEBUG)
  if (!enabled) return null
  const [online, setOnline] = useState(false)
  const [rate, setRate] = useState(0)
  const countRef = useRef(0)
  const [stats, setStats] = useState<any | null>(null)
  const [rtt, setRtt] = useState<number | null>(null)
  const prevStatsRef = useRef<any | null>(null)
  const [treeBatchesSeries, setTreeBatchesSeries] = useState<number[]>([])
  const [dropLowPriSeries, setDropLowPriSeries] = useState<number[]>([])
  const [broadcastsSeries, setBroadcastsSeries] = useState<number[]>([])
  const [treeBatchesInc, setTreeBatchesInc] = useState<number>(0)
  const [dropLowPriInc, setDropLowPriInc] = useState<number>(0)
  const [broadcastsInc, setBroadcastsInc] = useState<number>(0)
  const [resyncCount, setResyncCount] = useState<number>(0)
  const [minimized, setMinimized] = useState<boolean>(true)
  const [paused, setPaused] = useState<boolean>(false)
  const pausedRef = useRef(false)
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])
  const lastInfoRef = useRef<any | null>(null)
  const typeCounter = useRef<Record<string, number>>({})
  const [typeRate, setTypeRate] = useState<{ file: number; tree: number; ann: number }>({
    file: 0,
    tree: 0,
    ann: 0
  })
  const [chatRates, setChatRates] = useState<{ chat: number; codex: number; other: number }>({
    chat: 0,
    codex: 0,
    other: 0
  })
  const lastSubsRef = useRef<Array<{ topic: string; filter: any }> | null>(null)
  const slices = useChatTurnStore((s) => {
    try {
      const ids = Object.keys(s.byConv || {})
      let gen = 0
      for (const id of ids) {
        if ((s.byConv as any)[id]?.generating) gen += 1
      }
      return { sliceCount: ids.length, generatingCount: gen, currentId: s.conversationId || null }
    } catch {
      return { sliceCount: 0, generatingCount: 0, currentId: null as string | null }
    }
  })
  useEffect(() => {
    const sub = ws.online$.subscribe((v) => setOnline(Boolean(v)))
    const ev = ws.events$?.subscribe?.((e) => {
      if (pausedRef.current) return
      countRef.current += 1
      const m = e?.method || ''
      if (m) typeCounter.current[m] = (typeCounter.current[m] || 0) + 1
      if (e?.method === 'session.resync') setResyncCount((n) => n + 1)
    })
    const timer = setInterval(() => {
      // 记录订阅快照，便于暂停时冻结显示
      try {
        lastSubsRef.current = (ws as any).subscriptions || null
      } catch {}
      if (!pausedRef.current) {
        setRate(countRef.current)
        const file = typeCounter.current['file.changed'] || 0
        const tree = typeCounter.current['tree.changed'] || 0
        const ann = Object.keys(typeCounter.current)
          .filter((k) => k.startsWith('annotations.'))
          .reduce((a, k) => a + (typeCounter.current[k] || 0), 0)
        setTypeRate({ file, tree, ann })
        const keys = Object.keys(typeCounter.current)
        const chat = keys
          .filter((k) => k.startsWith('chat.'))
          .reduce((a, k) => a + (typeCounter.current[k] || 0), 0)
        const codex = keys
          .filter((k) => k.startsWith('codex/'))
          .reduce((a, k) => a + (typeCounter.current[k] || 0), 0)
        const total = Object.values(typeCounter.current).reduce((a, v) => a + (v || 0), 0)
        const other = Math.max(0, total - chat - codex - file - tree - ann)
        setChatRates({ chat, codex, other })
      } else {
        setRate(0)
      }
      countRef.current = 0
      typeCounter.current = {}
    }, 1000)
    // 订阅服务器周期性统计
    const statsSub = ws.events$?.subscribe?.((ev) => {
      if (ev?.method === 'session.stats') {
        const snap = ev.params || null
        const prev = prevStatsRef.current
        if (!pausedRef.current) setStats(snap)
        // 更新周期增量小图
        const d1 = computeDelta(prev, snap, 'treeChangedBatches')
        const d2 = computeDelta(prev, snap, 'droppedRingLowpri')
        const d3 = computeDelta(prev, snap, 'broadcastTotal')
        if (!pausedRef.current) {
          setTreeBatchesInc(d1)
          setDropLowPriInc(d2)
          setBroadcastsInc(d3)
          setTreeBatchesSeries((s) => updateSeries(s, d1, 10))
          setDropLowPriSeries((s) => updateSeries(s, d2, 10))
          setBroadcastsSeries((s) => updateSeries(s, d3, 10))
        }
        prevStatsRef.current = snap
      }
    })
    // RTT 采样
    const rttTimer = setInterval(async () => {
      try {
        const t0 = performance.now()
        const info = await ws.callOnce<any>('session.info', {})
        const t1 = performance.now()
        if (!pausedRef.current) setRtt(Math.round(t1 - t0))
        lastInfoRef.current = info
      } catch {}
    }, 5000)
    return () => {
      sub.unsubscribe()
      ev?.unsubscribe?.()
      statsSub?.unsubscribe?.()
      clearInterval(timer)
      clearInterval(rttTimer)
    }
  }, [])
  return (
    <div
      style={{
        position: 'fixed',
        right: 8,
        bottom: 8,
        background: 'rgba(0,0,0,0.6)',
        color: '#fff',
        borderRadius: 6,
        padding: '6px 8px',
        fontSize: 12,
        zIndex: 9999
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div>
          WS: {online ? 'online' : 'offline'} ({ws.state})
        </div>
        <button
          style={{
            padding: '0 6px',
            fontSize: 11,
            border: '1px solid #fff3',
            borderRadius: 4,
            background: paused ? '#7c2d12' : '#1f2937',
            color: '#fff'
          }}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? '已暂停' : '暂停'}
        </button>
        <button
          style={{
            padding: '0 6px',
            fontSize: 11,
            border: '1px solid #fff3',
            borderRadius: 4,
            background: '#1f2937',
            color: '#fff'
          }}
          onClick={() => setMinimized((m) => !m)}
        >
          {minimized ? '展开' : '收起'}
        </button>
        <button
          style={{
            padding: '0 6px',
            fontSize: 11,
            border: '1px solid #fff3',
            borderRadius: 4,
            background: '#1f2937',
            color: '#fff'
          }}
          onClick={() => {
            try {
              const nowTs = new Date().toISOString()
              const eid = Number(stats?.lastEventId || 0)
              const eid1 = eid + 1
              const eid2 = eid + 2
              const eid3 = eid + 3
              const eid4 = eid + 4
              const eid5 = eid + 5
              const snapshot = {
                info: lastInfoRef.current,
                stats,
                samples: {
                  explorer: {
                    requests: [
                      {
                        jsonrpc: '2.0',
                        id: 12,
                        method: 'file.getFull',
                        params: { path: 'docs/guide/ws-overview.md' }
                      },
                      { jsonrpc: '2.0', id: 21, method: 'tree.get', params: { dir: 'src' } },
                      { jsonrpc: '2.0', id: 31, method: 'annotations.list', params: {} },
                      {
                        jsonrpc: '2.0',
                        id: 41,
                        method: 'file.save',
                        params: { path: 'src/app.ts', content: '...', baseDigest: 'abc...' }
                      }
                    ],
                    notifications: [
                      {
                        jsonrpc: '2.0',
                        method: 'file.changed',
                        params: {
                          path: 'src/app.ts',
                          kind: 'modified',
                          digest: 'def...',
                          eventId: String(eid1),
                          ts: nowTs
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'tree.changed',
                        params: {
                          impactedPaths: ['src/app.ts', 'src/lib/util.ts'],
                          summary: {
                            created: 0,
                            modified: 2,
                            deleted: 0,
                            moved: 1,
                            truncated: false
                          },
                          eventId: String(eid2),
                          ts: nowTs
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'annotations.created',
                        params: {
                          annotation: { id: 'ann_1', filePath: 'src/app.ts' },
                          eventId: String(eid3),
                          ts: nowTs
                        }
                      },
                      { jsonrpc: '2.0', method: 'session.resync', params: { reason: 'truncated' } }
                    ],
                    resume: {
                      request: {
                        jsonrpc: '2.0',
                        id: 51,
                        method: 'events.resume',
                        params: { after: eid }
                      },
                      response: {
                        jsonrpc: '2.0',
                        id: 51,
                        result: {
                          events: [
                            {
                              jsonrpc: '2.0',
                              method: 'file.changed',
                              params: {
                                path: 'src/app.ts',
                                kind: 'modified',
                                eventId: String(eid1),
                                ts: nowTs
                              }
                            }
                          ],
                          truncated: false
                        }
                      }
                    }
                  },
                  codex: {
                    notifications: [
                      {
                        jsonrpc: '2.0',
                        method: 'codex/sessionConfigured',
                        params: {
                          provider: 'codex',
                          sessionId: 'session_abc',
                          conversationId: 'conv_abc',
                          model: 'o1-preview',
                          rolloutPath: '/tmp/conv_abc.jsonl',
                          historyLogId: 1,
                          historyEntryCount: 0,
                          eventId: String(eid1),
                          ts: nowTs
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'codex/event/agent_message_delta',
                        params: {
                          conversationId: 'conv_abc',
                          eventId: String(eid2),
                          ts: nowTs,
                          msg: { type: 'agent_message_delta', delta: '正在分析目录结构…' }
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'codex/event/agent_message',
                        params: {
                          conversationId: 'conv_abc',
                          eventId: String(eid3),
                          ts: nowTs,
                          msg: { type: 'agent_message', message: '分析完成：建议先梳理 API 边界。' }
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'codex/event/exec_command_begin',
                        params: {
                          conversationId: 'conv_abc',
                          eventId: String(eid4),
                          ts: nowTs,
                          msg: {
                            type: 'exec_command_begin',
                            call_id: 'exec-1',
                            command: ['rg', '-n', 'TODO'],
                            cwd: '/repo'
                          }
                        }
                      },
                      {
                        jsonrpc: '2.0',
                        method: 'codex/event/exec_command_end',
                        params: {
                          conversationId: 'conv_abc',
                          eventId: String(eid5),
                          ts: nowTs,
                          msg: {
                            type: 'exec_command_end',
                            call_id: 'exec-1',
                            exit_code: 0,
                            stdout: 'applied',
                            stderr: '',
                            aggregated_output: '',
                            formatted_output: '',
                            duration: '1200ms'
                          }
                        }
                      }
                    ]
                  },
                  docs: {
                    explorerCodexFormat: 'docs/guide/codex-chat-ws-ssot.md',
                    troubleshooting: 'docs/guide/ws-troubleshooting.md'
                  }
                }
              }
              const payload = JSON.stringify(snapshot, null, 2)
              ;(navigator as any)?.clipboard?.writeText?.(payload)
            } catch {}
          }}
        >
          复制快照
        </button>
      </div>
      {!minimized && (
        <>
          <div>
            events/s: {rate}{' '}
            <span style={{ opacity: 0.7 }}>
              chat:{chatRates.chat} codex:{chatRates.codex} other:{chatRates.other} · file:
              {typeRate.file} tree:{typeRate.tree} ann:{typeRate.ann}
            </span>
          </div>
          <div>
            subs:{' '}
            {(() => {
              const list = paused ? lastSubsRef.current || [] : (ws as any).subscriptions || []
              return list
                .map((s: any) => s.topic + (s && s.filter ? `(${tryBriefFilter(s.filter)})` : ''))
                .join(', ')
            })()}
          </div>
          <div>
            slices: {slices.sliceCount}（generating: {slices.generatingCount}） current:{' '}
            {slices.currentId || '-'}
          </div>
        </>
      )}
      {stats && (
        <div style={{ marginTop: 4, opacity: 0.9 }}>
          {!minimized && (
            <>
              <div>stats.ts: {stats.ts || '-'}</div>
              <div>
                server: {lastInfoRef.current?.serverVersion || '-'}, features:{' '}
                {Array.isArray(lastInfoRef.current?.features)
                  ? lastInfoRef.current.features.join(',')
                  : '-'}
              </div>
            </>
          )}
          <div>
            ring: {stats.ringSize}/{stats.ringCap} {renderRingBar(stats.ringSize, stats.ringCap)}
          </div>
          <div>lastEventId: {stats.lastEventId}</div>
          <div>
            broadcasts: {stats.broadcastTotal} (err:{stats.broadcastErrors} noRecv:
            {stats.noReceiver})
          </div>
          <div>droppedLowPri: {stats.droppedRingLowpri}</div>
          <div>fileChanged: {stats.fileChangedTotal}</div>
          <div>
            tree: batches {stats.treeChangedBatches}, impacted {stats.treeImpactedPathsTotal}, moved{' '}
            {stats.treeMovedTotal}, truncated {stats.treeTruncatedBatches}
          </div>
          {!minimized && (
            <>
              <div style={{ marginTop: 4 }}>
                tree.batches (+{treeBatchesInc}){' '}
                <MiniSparkline series={treeBatchesSeries} color="#60a5fa" />
              </div>
              <div>
                drop.lowPri (+{dropLowPriInc}){' '}
                <MiniSparkline series={dropLowPriSeries} color="#facc15" />
              </div>
              <div>
                broadcasts (+{broadcastsInc}){' '}
                <MiniSparkline series={broadcastsSeries} color="#34d399" />
              </div>
            </>
          )}
        </div>
      )}
      {!minimized && (
        <>
          {rtt != null && <div>RTT: {rtt}ms</div>}
          <div>
            events/s: <MiniSparkline series={[rate]} color="#4ade80" />
          </div>
          <div>resync count: {resyncCount}</div>
        </>
      )}
    </div>
  )
}

function MiniSparkline({ series, color = '#4ade80' }: { series: number[]; color?: string }) {
  const w = 80
  const h = 24
  const max = Math.max(1, ...series)
  const points = series
    .map((v, i) => {
      const x = (i / Math.max(1, series.length - 1)) * (w - 4) + 2
      const y = h - 2 - (v / max) * (h - 4)
      return `${x},${y}`
    })
    .join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block', marginTop: 4 }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1} />
      <rect
        x={0}
        y={0}
        width={w}
        height={h}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={1}
      />
    </svg>
  )
}

function renderRingBar(size: number, cap: number) {
  const pct = Math.max(0, Math.min(100, Math.round((size / Math.max(1, cap)) * 100)))
  const color = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f59e0b' : '#10b981'
  return (
    <span
      style={{
        display: 'inline-block',
        width: 60,
        height: 6,
        marginLeft: 6,
        background: '#ffffff1a',
        borderRadius: 3,
        verticalAlign: 'middle'
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: `${pct}%`,
          height: '100%',
          background: color,
          borderRadius: 3
        }}
      />
    </span>
  )
}

function tryBriefFilter(f: any): string {
  try {
    if (!f || typeof f !== 'object') return ''
    const keys = Object.keys(f)
    if (keys.length === 0) return ''
    const show = keys.slice(0, 2).map((k) => `${k}:${String((f as any)[k])}`)
    return show.join(',')
  } catch {
    return ''
  }
}
