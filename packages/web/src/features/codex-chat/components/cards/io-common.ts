import type { Turn, TurnStep } from '../../stores/chat-turns'

export function buildCmdAndCwdArgs(step: TurnStep) {
  const cmd = Array.isArray(step.meta?.command) ? step.meta.command.join(' ') : ''
  const cwd = typeof step.meta?.cwd === 'string' ? step.meta.cwd : ''
  return [cmd || '', cwd ? `(cwd=${cwd})` : ''].filter(Boolean).join('\n') || '(empty)'
}

export function buildReadLikeOutput(step: TurnStep, turn: Turn) {
  const body = String(step.body || '').trim()
  const stdout = typeof step.meta?.stdout === 'string' ? step.meta.stdout : ''
  const stderr = typeof step.meta?.stderr === 'string' ? step.meta.stderr : ''
  let merged = body || [stdout, stderr].filter(Boolean).join('\n')
  if (!merged) {
    try {
      const cmdKey = JSON.stringify(step.meta?.command || [])
      const cwdKey = String(step.meta?.cwd || '')
      const peer = (turn.steps || []).find((s) => {
        if (s.id === step.id) return false
        const k1 = JSON.stringify((s as any)?.meta?.command || [])
        const k2 = String((s as any)?.meta?.cwd || '')
        return k1 === cmdKey && k2 === cwdKey
      }) as any
      if (peer) {
        const pout = String(peer.body || '').trim()
        const pstdout = typeof peer.meta?.stdout === 'string' ? peer.meta.stdout : ''
        const pstderr = typeof peer.meta?.stderr === 'string' ? peer.meta.stderr : ''
        merged = pout || [pstdout, pstderr].filter(Boolean).join('\n')
      }
    } catch {}
  }
  return merged
}
