// 轻量“影子存储”：在 Store 之外缓存完整的工具输出，避免触发大规模重渲染。
// Key 使用 stepId（更稳定）；appendStep 可通过 toolIndex 定位 stepId。

const VAULT = new Map<string, string>()

function getMaxVaultBytesPerStep(): number {
  try {
    const v = (import.meta as any).env?.VITE_CHAT_EXEC_VAULT_MAX_BYTES_PER_STEP
    if (v == null) return 5 * 1024 * 1024 // 5MB 默认上限
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 1024 * 1024
  } catch {
    return 5 * 1024 * 1024
  }
}

export function appendExecOutput(key: string, chunk: string) {
  if (!key || !chunk) return
  const prev = VAULT.get(key) || ''
  const max = getMaxVaultBytesPerStep()
  if (prev.length >= max) return
  const remain = max - prev.length
  const take = remain >= chunk.length ? chunk : chunk.slice(0, remain)
  VAULT.set(key, prev + take)
}

export function getExecOutput(key: string): string | null {
  if (!key) return null
  return VAULT.get(key) ?? null
}

export function hasExecOutput(key: string): boolean {
  return VAULT.has(key)
}

export function clearExecOutput(key: string) {
  VAULT.delete(key)
}
