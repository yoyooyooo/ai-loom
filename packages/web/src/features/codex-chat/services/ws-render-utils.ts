export function renderPatchDiff(changes: any, maxFiles: number, maxChars: number): string {
  try {
    const entries = Object.entries(changes || {}) as Array<[string, any]>
    const limited = entries.slice(
      0,
      Math.max(1, Number.isFinite(maxFiles) ? maxFiles : entries.length)
    )
    const blocks: string[] = []
    for (const [path, change] of limited) {
      if (!change || typeof change !== 'object') continue
      if (change.update && typeof change.update.unified_diff === 'string') {
        blocks.push(`### ${path}\n\n\`\`\`diff\n${change.update.unified_diff}\n\`\`\``)
      } else if (change.add && typeof change.add.content === 'string') {
        const content = change.add.content.replace(/\n/g, '\n+ ')
        blocks.push(`### ${path}\n\n\`\`\`diff\n+ ${content}\n\`\`\``)
      } else if (change.delete && typeof change.delete.content === 'string') {
        const content = change.delete.content.replace(/\n/g, '\n- ')
        blocks.push(`### ${path}\n\n\`\`\`diff\n- ${content}\n\`\`\``)
      }
    }
    let out = blocks.join('\n\n')
    if (typeof out === 'string' && Number.isFinite(maxChars) && out.length > maxChars) {
      out = out.slice(0, maxChars) + '\n... (diff truncated)'
    }
    return out
  } catch {
    return ''
  }
}
