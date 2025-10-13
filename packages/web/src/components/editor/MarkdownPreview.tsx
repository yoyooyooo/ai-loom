import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'

type Mark = { id?: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number }

type Props = {
  content: string
  annotations?: Mark[]
  onSelectionChange?: (sel: { startLine: number; endLine: number; startColumn?: number; endColumn?: number; selectedText: string } | null) => void
  onOpenMark?: (mark: Mark) => void
}

export type PreviewHandle = { reveal: (startLine: number, endLine: number) => void }

const MarkdownPreview = forwardRef<PreviewHandle, Props>(function MarkdownPreview({ content, annotations = [], onSelectionChange, onOpenMark }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // rehype 插件：把节点位置信息写入 data-sourcepos
  function withSourcePos() {
    return (tree: any) => {
      visit(tree, (node: any, index: number | null, parent: any) => {
        if (!node || typeof node !== 'object' || !node.position) return
        const p = node.position
        const start = p.start || { line: 1, column: 1 }
        const end = p.end || start
        if (node.type === 'text') {
          const val: string = (node.value || '').toString()
          if (!val.trim() || !parent || typeof index !== 'number') return
          // 用 span 包裹文本节点，写入 data-sourcepos，便于“子串级”更精细的高亮
          const span = {
            type: 'element',
            tagName: 'span',
            properties: { 'data-sourcepos': `${start.line}:${start.column}-${end.line}:${end.column}` },
            children: [ node ],
          }
          parent.children[index] = span
        } else if (node.type === 'element') {
          node.properties = node.properties || {}
          node.properties['data-sourcepos'] = `${start.line}:${start.column}-${end.line}:${end.column}`
        }
      })
    }
  }

  const html = useMemo(() => {
    try {
      const file = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype, { allowDangerousHtml: false })
        .use(withSourcePos as any)
        .use(rehypeStringify)
        .processSync(content)
      return String(file)
    } catch (e) {
      return `<pre class="text-red-600">预览渲染失败</pre>`
    }
  }, [content])

  // 在渲染后，根据 annotations 给相交的元素打高亮 class
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    // 重置为干净的 HTML（移除上一次分割/包裹）
    el.innerHTML = html
    if (!annotations || annotations.length === 0) return

    // 对每条批注，精确到子串级包裹（仅在文本 span 内分割并上色）
    for (const m of annotations) {
      const spans = Array.from(el.querySelectorAll('span[data-sourcepos]')) as HTMLElement[]
      for (const span of spans) {
        // 要求是“文本包装 span”：只含一个 Text 子节点
        if (span.childNodes.length !== 1 || span.firstChild?.nodeType !== Node.TEXT_NODE) continue
        const sp = parseSourcePos(span.getAttribute('data-sourcepos'))
        if (!sp) continue
        const ov = intersectRange(sp, m)
        if (!ov) continue
        // 计算在该文本节点中的子串边界（基于行列 → 索引）
        const text = span.textContent || ''
        const idxStart = offsetFromPos(text, { line: sp.startLine, column: sp.startColumn }, { line: ov.startLine, column: ov.startColumn })
        const idxEnd = offsetFromPos(text, { line: sp.startLine, column: sp.startColumn }, { line: ov.endLine, column: ov.endColumn })
        if (idxStart >= idxEnd) continue

        const pre = text.slice(0, idxStart)
        const mid = text.slice(idxStart, idxEnd)
        const suf = text.slice(idxEnd)

        // 构造节点，并计算各自的 sourcepos
        const preStart = { line: sp.startLine, column: sp.startColumn }
        const preEnd = advancePos(preStart, pre)
        const midStart = preEnd
        const midEnd = advancePos(midStart, mid)
        const sufStart = midEnd
        const sufEnd = { line: sp.endLine, column: sp.endColumn }

        const frag = document.createDocumentFragment()
        if (pre) {
          const preSpan = document.createElement('span')
          preSpan.setAttribute('data-sourcepos', `${preStart.line}:${preStart.column}-${preEnd.line}:${preEnd.column}`)
          preSpan.textContent = pre
          frag.appendChild(preSpan)
        }
        const midSpan = document.createElement('span')
        midSpan.className = 'ailoom-anno-inline'
        if (m.id) midSpan.setAttribute('data-mark-id', m.id)
        midSpan.setAttribute('data-sourcepos', `${midStart.line}:${midStart.column}-${midEnd.line}:${midEnd.column}`)
        midSpan.textContent = mid
        frag.appendChild(midSpan)
        if (suf) {
          const sufSpan = document.createElement('span')
          sufSpan.setAttribute('data-sourcepos', `${sufStart.line}:${sufStart.column}-${sufEnd.line}:${sufEnd.column}`)
          sufSpan.textContent = suf
          frag.appendChild(sufSpan)
        }
        // 用分割后的片段替换原 span
        span.replaceWith(frag)
      }
    }
  }, [html, annotations])

  // 选择映射：将 DOM 选择映射到源行列
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseUp = () => {
      if (!onSelectionChange) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.toString().trim()) { onSelectionChange(null); return }
      const a = sel.anchorNode as Node | null
      const f = sel.focusNode as Node | null
      const startEl = a ? closestWithSourcePos(a) : null
      const endEl = f ? closestWithSourcePos(f) : null
      const s1 = startEl ? parseSourcePos(startEl.getAttribute('data-sourcepos') || '') : null
      const s2 = endEl ? parseSourcePos(endEl.getAttribute('data-sourcepos') || '') : null
      if (!s1 || !s2) { onSelectionChange(null); return }
      const startLine = Math.min(s1.startLine, s2.startLine)
      const endLine = Math.max(s1.endLine, s2.endLine)
      // 列精度暂取端点列，跨节点时近似
      const startColumn = s1.startLine <= s2.startLine ? s1.startColumn : s2.startColumn
      const endColumn = s2.endLine >= s1.endLine ? s2.endColumn : s1.endColumn
      const selectedText = sel.toString()
      onSelectionChange({ startLine, endLine, startColumn, endColumn, selectedText })
    }
    el.addEventListener('mouseup', onMouseUp)
    return () => { el.removeEventListener('mouseup', onMouseUp) }
  }, [onSelectionChange])

  // 命中标注时打开编辑浮层
  useEffect(() => {
    const el = containerRef.current
    if (!el || !onOpenMark) return
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      const hit = target.closest('[data-mark-id], .ailoom-anno-inline') as HTMLElement | null
      if (!hit) return
      ev.preventDefault(); ev.stopPropagation()
      const id = hit.getAttribute('data-mark-id') || undefined
      const sp = parseSourcePos(hit.getAttribute('data-sourcepos') || '')
      if (sp) onOpenMark({ id, startLine: sp.startLine, endLine: sp.endLine, startColumn: sp.startColumn, endColumn: sp.endColumn })
    }
    el.addEventListener('mousedown', onClick, true)
    return () => { el.removeEventListener('mousedown', onClick, true) }
  }, [onOpenMark, annotations])

  useImperativeHandle(ref, () => ({
    reveal: (startLine: number, endLine: number) => {
      const el = containerRef.current
      if (!el) return
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-sourcepos]'))
      let best: HTMLElement | null = null
      for (const n of nodes) {
        const sp = parseSourcePos(n.getAttribute('data-sourcepos'))
        if (!sp) continue
        if (!(sp.endLine < startLine || sp.startLine > endLine)) { best = n; break }
      }
      if (best) {
        best.scrollIntoView({ block: 'center', behavior: 'auto' })
      }
    }
  }))

  return (
    <div className="w-full h-full border rounded overflow-auto">
      <div ref={containerRef} className="prose prose-sm dark:prose-invert max-w-none p-3" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

export default MarkdownPreview

function parseSourcePos(s: string | null) {
  if (!s) return null
  const m = s.match(/(\d+):(\d+)-(\d+):(\d+)/)
  if (!m) return null
  return { startLine: parseInt(m[1]), startColumn: parseInt(m[2]), endLine: parseInt(m[3]), endColumn: parseInt(m[4]) }
}

function rangeOverlap(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }) {
  return !(a.endLine < b.startLine || b.endLine < a.startLine)
}

function intersectRange(a: { startLine: number; startColumn?: number; endLine: number; endColumn?: number }, b: { startLine: number; startColumn?: number; endLine: number; endColumn?: number }) {
  // 行级相交
  if (a.endLine < b.startLine || b.endLine < a.startLine) return null
  const startLine = Math.max(a.startLine, b.startLine)
  const endLine = Math.min(a.endLine, b.endLine)
  const startColumn = (startLine === a.startLine ? a.startColumn ?? 1 : 1)
  const startColumnB = (startLine === b.startLine ? b.startColumn ?? 1 : 1)
  const endColumn = (endLine === a.endLine ? a.endColumn ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
  const endColumnB = (endLine === b.endLine ? b.endColumn ?? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER)
  return {
    startLine,
    startColumn: Math.max(startColumn, startColumnB),
    endLine,
    endColumn: Math.min(endColumn, endColumnB),
  }
}

function advancePos(start: { line: number; column: number }, text: string) {
  let line = start.line, column = start.column
  for (const ch of text) {
    if (ch === '\n') { line += 1; column = 1 } else { column += 1 }
  }
  return { line, column }
}

function offsetFromPos(text: string, base: { line: number; column: number }, target: { line: number; column: number }) {
  // 计算 target 在 text 中的字符索引（0-based），base 是 text 起始的源位置
  let line = base.line, col = base.column
  let idx = 0
  if (target.line < line || (target.line === line && target.column <= col)) return 0
  for (const ch of text) {
    if (line > target.line || (line === target.line && col >= target.column)) break
    if (ch === '\n') { line += 1; col = 1 } else { col += 1 }
    idx += 1
    if (line > target.line || (line === target.line && col >= target.column)) break
  }
  return idx
}

function closestWithSourcePos(n: Node | null): HTMLElement | null {
  let el: HTMLElement | null = (n as HTMLElement | null)
  while (el && el.nodeType === Node.TEXT_NODE) {
    el = (el.parentElement as HTMLElement | null)
  }
  while (el) {
    if (el.getAttribute && el.getAttribute('data-sourcepos')) return el
    el = el.parentElement
  }
  return null
}

// 暴露 reveal 能力（按行范围滚动到视图中间）
// 注意：需要在默认导出后定义 useImperativeHandle（仍在组件作用域）
;(MarkdownPreview as any).displayName = 'MarkdownPreview'

// monkey patch useImperativeHandle via component function body
// 由于 forwardRef 中无法在外部再次使用 hooks，这里导出时已在组件内部声明了 ref 能力。
