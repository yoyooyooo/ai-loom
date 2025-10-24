const isEnabled = (() => {
  try {
    const flag = (import.meta as any).env?.VITE_CHAT_TRACE
    if (flag == null) return false
    const v = String(flag).toLowerCase()
    return v === '1' || v === 'true'
  } catch {
    return false
  }
})()

export function chatTrace(label: string, payload?: unknown) {
  if (!isEnabled) return
  try {
    if (payload === undefined) {
      // eslint-disable-next-line no-console
      console.log(`[chat-trace] ${label}`)
    } else {
      // eslint-disable-next-line no-console
      console.log(`[chat-trace] ${label}`, payload)
    }
  } catch {
    // ignore logging errors
  }
}

export function chatTraceEnabled() {
  return isEnabled
}
