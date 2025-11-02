export function summarizeFirstLine(input: string, max = 80): string {
  try {
    const raw = String(input || '').replace(/\r/g, '')
    const lines = raw.split(/\n/)
    const first = (lines.find((ln) => ln.trim().length > 0) || '').trim()
    if (!first) return ''
    const title = first
      .replace(/^[\s#>*_`]+/, '')
      .replace(/[\s#*_`]+$/, '')
      .trim()
    return title.length > max ? `${title.slice(0, max)}…` : title
  } catch {
    return ''
  }
}

export function nowISO(): string {
  return new Date().toISOString()
}

// 去除正文中与标题重复的首行（通常为 Markdown 一级标题或首句）
// 规则：
// - 计算正文第一条非空行，若其在去除 Markdown 装饰符后与传入的 title 等价，则移除该行
// - 同时跳过其后的连续空行，仅移除一段空白块，保留后续正文结构
// - 若无匹配或内容为空，返回原文
export function stripDuplicatedTitle(content: string, title?: string): string {
  const raw = String(content || '')
  if (!raw.trim() || !title) return raw
  const lines = raw.replace(/\r/g, '').split(/\n/)
  let firstIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      firstIdx = i
      break
    }
  }
  if (firstIdx < 0) return raw
  const norm = (s: string) =>
    s
      .replace(/^[\s#>*_`]+/, '')
      .replace(/[\s#*_`]+$/, '')
      .trim()
  if (norm(lines[firstIdx]) !== norm(title)) return raw
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === firstIdx) continue
    if (i === firstIdx + 1) {
      let j = i
      while (j < lines.length && lines[j].trim().length === 0) j++
      i = j - 1
      continue
    }
    out.push(lines[i])
  }
  return out.join('\n')
}
