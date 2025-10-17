import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { visit } from 'unist-util-visit'
import type { AnchorRect, ViewerSelection } from '@/components/editor/types'

type Mark = {
  id?: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
}

type Props = {
  content: string
  annotations?: Mark[]
  onSelectionChange?: (sel: ViewerSelection | null) => void
  onOpenMark?: (mark: Mark, anchorRect?: AnchorRect) => void
  // 浮层锚点变化（滚动/尺寸变更时回调）
  onAnchorChange?: (rect: AnchorRect | null) => void
  // 当锚点来源是具体元素（如命中高亮 span）时，暴露该元素，便于上层用 floating-ui 自动跟随
  onAnchorElChange?: (el: HTMLElement | null) => void
  // 当锚点来源是 Range（备份）时，暴露该 Range，便于上层在元素短暂不可测量时复算
  onAnchorRangeChange?: (range: Range | null) => void
  // 暴露预览容器元素，便于上层在虚拟锚点中计算多段高亮的联合边界
  onContainerElChange?: (el: HTMLElement | null) => void
  // 暴露滚动容器元素，使 floating-ui 能在其滚动时 autoUpdate
  onScrollElChange?: (el: HTMLElement | null) => void
  // 暴露 overlay 层元素，便于将浮层 Portal 到该节点
  onOverlayElChange?: (el: HTMLElement | null) => void
}

export type PreviewHandle = { reveal: (startLine: number, endLine: number) => void }

const MarkdownPreview = forwardRef<PreviewHandle, Props>(function MarkdownPreview(
  { content, annotations = [], onSelectionChange, onOpenMark, onAnchorChange, onAnchorElChange, onAnchorRangeChange, onContainerElChange, onScrollElChange, onOverlayElChange },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)

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
            properties: {
              'data-sourcepos': `${start.line}:${start.column}-${end.line}:${end.column}`
            },
            children: [node]
          }
          parent.children[index] = span
        } else if (node.type === 'element') {
          node.properties = node.properties || {}
          node.properties['data-sourcepos'] =
            `${start.line}:${start.column}-${end.line}:${end.column}`
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
        const idxStart = offsetFromPos(
          text,
          { line: sp.startLine, column: sp.startColumn },
          { line: ov.startLine, column: ov.startColumn }
        )
        const idxEnd = offsetFromPos(
          text,
          { line: sp.startLine, column: sp.startColumn },
          { line: ov.endLine, column: ov.endColumn }
        )
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
          preSpan.setAttribute(
            'data-sourcepos',
            `${preStart.line}:${preStart.column}-${preEnd.line}:${preEnd.column}`
          )
          preSpan.textContent = pre
          frag.appendChild(preSpan)
        }
        const midSpan = document.createElement('span')
        midSpan.className = 'ailoom-anno-inline'
        if (m.id) midSpan.setAttribute('data-mark-id', m.id)
        midSpan.setAttribute(
          'data-sourcepos',
          `${midStart.line}:${midStart.column}-${midEnd.line}:${midEnd.column}`
        )
        midSpan.textContent = mid
        frag.appendChild(midSpan)
        if (suf) {
          const sufSpan = document.createElement('span')
          sufSpan.setAttribute(
            'data-sourcepos',
            `${sufStart.line}:${sufStart.column}-${sufEnd.line}:${sufEnd.column}`
          )
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
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        onSelectionChange(null)
        onAnchorChange?.(null)
        return
      }
      // 计算精准行列：使用 Range 起止点在所属 span[data-sourcepos] 内的字符偏移推进行列
      const rng = (() => {
        try { return sel.getRangeAt(0) } catch { return null }
      })()
      if (!rng) return
      try { onAnchorRangeChange?.(rng.cloneRange()) } catch {}
      const startPos = posFromDomPoint(rng.startContainer, rng.startOffset)
      const endPos = posFromDomPoint(rng.endContainer, rng.endOffset)
      if (!startPos || !endPos) {
        onSelectionChange(null)
        onAnchorChange?.(null)
        return
      }
      // 规范化顺序
      const aFirst = comparePos(startPos, endPos) <= 0
      const sPos = aFirst ? startPos : endPos
      const ePos = aFirst ? endPos : startPos
      const selectedText = sel.toString()
      // 计算选择范围的 bounding rect 作为锚点
      let anchorRect: AnchorRect | undefined
      try {
        const rectList = rng.getClientRects()
        const r = rectList && rectList.length > 0 ? rectList[0] : rng.getBoundingClientRect()
        anchorRect = { x: r.left, y: r.top, width: r.width, height: r.height }
      } catch {}
      onSelectionChange({
        startLine: sPos.line,
        endLine: ePos.line,
        startColumn: sPos.column,
        endColumn: ePos.column,
        selectedText,
        anchorRect
      })
      if (anchorRect) onAnchorChange?.(anchorRect)
      // 选区为锚点来源：清空元素锚点
      onAnchorElChange?.(null)
    }
    el.addEventListener('mouseup', onMouseUp)
    return () => {
      el.removeEventListener('mouseup', onMouseUp)
    }
  }, [onSelectionChange, onAnchorChange])

  // 命中标注时打开编辑浮层
  useEffect(() => {
    const el = containerRef.current
    if (!el || !onOpenMark) return
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      const hit = target.closest('[data-mark-id], .ailoom-anno-inline') as HTMLElement | null
      if (!hit) return
      ev.preventDefault()
      ev.stopPropagation()
      // 计算锚点矩形（命中元素）
      const rect = hit.getBoundingClientRect()
      const anchorRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
      const id = hit.getAttribute('data-mark-id') || undefined
      const sp = parseSourcePos(hit.getAttribute('data-sourcepos') || '')
      // 备份一个基于命中元素的 Range，作为滚动/重渲时的兜底锚点
      try {
        const r = document.createRange()
        r.selectNodeContents(hit)
        onAnchorRangeChange?.(r)
      } catch { onAnchorRangeChange?.(null) }
      if (sp) {
        onOpenMark(
          {
            id,
            startLine: sp.startLine,
            endLine: sp.endLine,
            startColumn: sp.startColumn,
            endColumn: sp.endColumn
          },
          anchorRect
        )
        onAnchorChange?.(anchorRect)
        onAnchorElChange?.(hit)
      }
    }
    el.addEventListener('mousedown', onClick, true)
    return () => {
      el.removeEventListener('mousedown', onClick, true)
    }
  }, [onOpenMark, annotations, onAnchorChange])

  // 滚动/尺寸跟随交由 floating-ui 的 autoUpdate 处理（父组件设置了 contextElement）
  useEffect(() => {
    onContainerElChange?.(containerRef.current)
    return () => onContainerElChange?.(null)
  }, [onContainerElChange])
  useEffect(() => {
    onScrollElChange?.(scrollRef.current)
    return () => onScrollElChange?.(null)
  }, [onScrollElChange])
  useEffect(() => {
    onOverlayElChange?.(overlayRef.current)
    return () => onOverlayElChange?.(null)
  }, [onOverlayElChange])

  useImperativeHandle(ref, () => ({
    reveal: (startLine: number, endLine: number) => {
      const el = containerRef.current
      if (!el) return
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-sourcepos]'))
      let best: HTMLElement | null = null
      for (const n of nodes) {
        const sp = parseSourcePos(n.getAttribute('data-sourcepos'))
        if (!sp) continue
        if (!(sp.endLine < startLine || sp.startLine > endLine)) {
          best = n
          break
        }
      }
      if (best) {
        // 将匹配元素滚动到容器顶部
        best.scrollIntoView({ block: 'start', behavior: 'auto' })
      }
    }
  }))

  return (
    <div ref={scrollRef} className="w-full h-full border rounded overflow-auto">
      <div className="relative min-h-full">
        <div
          ref={containerRef}
          className="prose prose-sm dark:prose-invert max-w-none p-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <div ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      </div>
    </div>
  )
})

export default MarkdownPreview

function parseSourcePos(s: string | null) {
  if (!s) return null
  const m = s.match(/(\d+):(\d+)-(\d+):(\d+)/)
  if (!m) return null
  return {
    startLine: parseInt(m[1]),
    startColumn: parseInt(m[2]),
    endLine: parseInt(m[3]),
    endColumn: parseInt(m[4])
  }
}

function comparePos(a: { line: number; column: number }, b: { line: number; column: number }) {
  if (a.line !== b.line) return a.line - b.line
  return a.column - b.column
}

function posFromDomPoint(node: Node, offset: number): { line: number; column: number } | null {
  const host = closestWithSourcePos(node)
  if (!host) return null
  const sp = parseSourcePos(host.getAttribute('data-sourcepos'))
  if (!sp) return null
  try {
    const r = document.createRange()
    r.selectNodeContents(host)
    // 将 range 结束点设为当前点，从而获取前缀文本长度
    r.setEnd(node, offset)
    const prefix = r.toString()
    const cur = advancePos({ line: sp.startLine, column: sp.startColumn }, prefix)
    return { line: cur.line, column: cur.column }
  } catch {
    return { line: sp.startLine, column: sp.startColumn }
  }
}

function rangeOverlap(
  a: { startLine: number; endLine: number },
  b: { startLine: number; endLine: number }
) {
  return !(a.endLine < b.startLine || b.endLine < a.startLine)
}

function intersectRange(
  a: { startLine: number; startColumn?: number; endLine: number; endColumn?: number },
  b: { startLine: number; startColumn?: number; endLine: number; endColumn?: number }
) {
  // 行级相交
  if (a.endLine < b.startLine || b.endLine < a.startLine) return null
  const startLine = Math.max(a.startLine, b.startLine)
  const endLine = Math.min(a.endLine, b.endLine)
  const startColumn = startLine === a.startLine ? (a.startColumn ?? 1) : 1
  const startColumnB = startLine === b.startLine ? (b.startColumn ?? 1) : 1
  const endColumn =
    endLine === a.endLine ? (a.endColumn ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  const endColumnB =
    endLine === b.endLine ? (b.endColumn ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
  return {
    startLine,
    startColumn: Math.max(startColumn, startColumnB),
    endLine,
    endColumn: Math.min(endColumn, endColumnB)
  }
}

function advancePos(start: { line: number; column: number }, text: string) {
  let line = start.line,
    column = start.column
  for (const ch of text) {
    if (ch === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}

function offsetFromPos(
  text: string,
  base: { line: number; column: number },
  target: { line: number; column: number }
) {
  // 计算 target 在 text 中的字符索引（0-based），base 是 text 起始的源位置
  let line = base.line,
    col = base.column
  let idx = 0
  if (target.line < line || (target.line === line && target.column <= col)) return 0
  for (const ch of text) {
    if (line > target.line || (line === target.line && col >= target.column)) break
    if (ch === '\n') {
      line += 1
      col = 1
    } else {
      col += 1
    }
    idx += 1
    if (line > target.line || (line === target.line && col >= target.column)) break
  }
  return idx
}

function closestWithSourcePos(n: Node | null): HTMLElement | null {
  let el: HTMLElement | null = n as HTMLElement | null
  while (el && el.nodeType === Node.TEXT_NODE) {
    el = el.parentElement as HTMLElement | null
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
