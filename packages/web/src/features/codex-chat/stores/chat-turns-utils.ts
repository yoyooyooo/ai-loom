export function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first.replace(/^[\s#>*_`]+/, '').replace(/[\s#*_`]+$/, '').trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

export function nowISO(): string {
  return new Date().toISOString()
}

