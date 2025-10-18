import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MarkdownPreview, { PreviewHandle } from '@/components/editor/MarkdownPreview'
import { Textarea } from '@/components/ui/textarea'
import type { ViewerSelection } from '@/components/editor/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAnnotations, createAnnotation, updateAnnotation, deleteAnnotation } from '@/features/explorer/api/annotations'
import { fetchFileFull } from '@/features/explorer/api/files'
import type { Annotation } from '@/lib/api/types'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import { useMarkdownFloatingAnnotation } from '@/components/editor/use-markdown-floating-annotation'

export default function EditorPanelMarkdown() {
  const qc = useQueryClient()
  const { data: anns } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })

  const { selectedPath } = useAppStore()
  const {
    selection,
    setSelection,
    showToolbar,
    openToolbar,
    closeToolbar,
    comment,
    setComment,
    activeAnnId,
    setActiveAnnId,
    consumePendingJump,
    pendingJump
  } = useExplorerStore()

  const previewRef = useRef<PreviewHandle | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const previewHostRef = useRef<HTMLElement | null>(null)
  const previewScrollRef = useRef<HTMLElement | null>(null)
  const previewOverlayRef = useRef<HTMLElement | null>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)
  const lastEditedRef = useRef<Map<string, Annotation>>(new Map())

  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null)
  useEffect(() => { setContainerEl(containerRef.current) }, [])

  const floating = useMarkdownFloatingAnnotation({
    containerEl,
    previewHostEl: previewHostRef.current,
    previewScrollEl: previewScrollRef.current,
    show: showToolbar,
    activeMarkId: activeAnnId
  })

  const [mdContent, setMdContent] = useState<string | null>(null)
  const [mdError, setMdError] = useState<string | null>(null)

  // 预览内容加载
  useEffect(() => {
    const run = async () => {
      if (!selectedPath || !selectedPath.toLowerCase().endsWith('.md')) {
        setMdContent(null)
        setMdError(null)
        return
      }
      try {
        const f = await fetchFileFull(selectedPath)
        setMdContent(f.content)
        setMdError(null)
      } catch (e: any) {
        setMdContent(null)
        const msg = String(e?.message || '')
        if (msg.startsWith('OVER_LIMIT') || msg.startsWith('HTTP_413')) {
          setMdError('预览不可用：文件过大，无法全量读取')
        } else if (msg.includes('NON_TEXT') || msg.startsWith('HTTP_415')) {
          setMdError('预览不可用：该文件不是文本')
        } else {
          setMdError('预览加载失败')
        }
      }
    }
    run()
  }, [selectedPath])

  // 浮层聚焦
  useEffect(() => {
    if (!showToolbar) return
    const ready = floating.x != null && floating.y != null
    if (!ready) return
    setTimeout(() => {
      const el = inputRef.current
      if (!el) return
      try {
        ;(el as any).focus?.({ preventScroll: true })
      } catch {
        try { el.focus() } catch {}
      }
      try {
        const len = el.value?.length ?? 0
        el.setSelectionRange(len, len)
      } catch {}
    }, 0)
  }, [showToolbar, floating.x, floating.y])

  // Markdown 模式：启用严格判定的“点击外部关闭”
  useEffect(() => {
    if (!showToolbar) return
    const state = { down: false, x: 0, y: 0, moved: false, scrolled: false }
    const onPointerDown = (e: PointerEvent) => {
      state.down = true
      state.x = e.clientX
      state.y = e.clientY
      state.moved = false
      state.scrolled = false
    }
    const onPointerMove = (e: PointerEvent) => {
      if (!state.down) return
      const dx = Math.abs(e.clientX - state.x)
      const dy = Math.abs(e.clientY - state.y)
      if (dx > 3 || dy > 3) state.moved = true
    }
    const onPointerCancel = () => { state.scrolled = true }
    const onAnyScroll = () => { if (state.down) state.scrolled = true }
    const onClick = (e: MouseEvent) => {
      const shouldConsider = state.down && !state.moved && !state.scrolled && e.button === 0
      state.down = false
      if (!shouldConsider) return
      const t = e.target as HTMLElement | null
      const panel = toolbarRef.current
      if (!t || !panel) return
      if (panel.contains(t)) return
      // 点击到高亮不关闭
      const hit = t.closest('[data-mark-id], .ailoom-anno-inline')
      if (hit) return
      closeToolbar()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    document.addEventListener('scroll', onAnyScroll, true)
    document.addEventListener('wheel', onAnyScroll, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      document.removeEventListener('scroll', onAnyScroll, true)
      document.removeEventListener('wheel', onAnyScroll, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [showToolbar, closeToolbar])

  // ESC 关闭
  useEffect(() => {
    if (!showToolbar) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeToolbar()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [showToolbar, closeToolbar])

  // 处理批注跳转（Markdown）
  useEffect(() => {
    if (!pendingJump || !selectedPath) return
    if (!mdContent) return
    const { startLine: s, endLine: e } = pendingJump
    previewRef.current?.reveal?.(s, e)
    setSelection({
      startLine: s,
      endLine: e,
      selectedText: '',
      startColumn: pendingJump.startColumn,
      endColumn: pendingJump.endColumn
    })
    if (pendingJump.id) setActiveAnnId(pendingJump.id)
    if (pendingJump.comment) setComment(pendingJump.comment)
    consumePendingJump()
  }, [pendingJump, selectedPath, mdContent])

  const onSelectionChange = (s: ViewerSelection | null) => {
    if (showToolbar) return
    if (!s) return
    if (s.anchorRect) floating.setAnchorRect(s.anchorRect)
    setSelection({
      startLine: s.startLine,
      endLine: s.endLine,
      startColumn: s.startColumn,
      endColumn: s.endColumn,
      selectedText: s.selectedText
    })
    setActiveAnnId(null)
    setComment('')
    openToolbar()
  }

  const doCreate = async () => {
    if (!selectedPath || !selection) return
    if (!comment.trim()) return
    const selText = (() => {
      if (mdContent) {
        try {
          const lines = mdContent.split('\n')
          const sL = Math.max(1, selection.startLine)
          const eL = Math.max(1, selection.endLine)
          const sC = Math.max(1, selection.startColumn || 1)
          const eC = Math.max(1, selection.endColumn || 1)
          if (sL === eL) {
            const line = lines[sL - 1] || ''
            return line.slice(sC - 1, eC - 1)
          }
          const parts: string[] = []
          parts.push((lines[sL - 1] || '').slice(sC - 1))
          for (let l = sL + 1; l <= eL - 1; l++) parts.push(lines[l - 1] || '')
          parts.push((lines[eL - 1] || '').slice(0, eC - 1))
          return parts.join('\n')
        } catch {}
      }
      return selection.selectedText
    })()
    const created = await createAnnotation({
      filePath: selectedPath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      selectedText: selText,
      comment: comment.trim(),
      priority: 'P1'
    })
    lastEditedRef.current.set(created.id, created)
    qc.setQueryData(['annotations'], (prev: any) => {
      if (!Array.isArray(prev)) return [created]
      const exists = prev.findIndex((a: any) => a.id === created.id)
      if (exists >= 0) {
        const next = prev.slice()
        next[exists] = created
        return next
      }
      return [created, ...prev]
    })
    await qc.invalidateQueries({ queryKey: ['annotations'] })
    setComment('')
    closeToolbar()
    setActiveAnnId(null)
  }

  const doUpdate = async () => {
    if (!activeAnnId || !selectedPath || !selection) return
    if (!comment.trim()) return
    const selText = (() => {
      if (mdContent) {
        try {
          const lines = mdContent.split('\n')
          const sL = Math.max(1, selection.startLine)
          const eL = Math.max(1, selection.endLine)
          const sC = Math.max(1, selection.startColumn || 1)
          const eC = Math.max(1, selection.endColumn || 1)
          if (sL === eL) {
            const line = lines[sL - 1] || ''
            return line.slice(sC - 1, eC - 1)
          }
          const parts: string[] = []
          parts.push((lines[sL - 1] || '').slice(sC - 1))
          for (let l = sL + 1; l <= eL - 1; l++) parts.push(lines[l - 1] || '')
          parts.push((lines[eL - 1] || '').slice(0, eC - 1))
          return parts.join('\n')
        } catch {}
      }
      return selection.selectedText
    })()
    const updated = await updateAnnotation(activeAnnId, {
      filePath: selectedPath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      selectedText: selText,
      comment: comment.trim()
    })
    lastEditedRef.current.set(updated.id, updated)
    qc.setQueryData(['annotations'], (prev: any) => {
      if (!Array.isArray(prev)) return prev
      return prev.map((a: any) => (a.id === updated.id ? updated : a))
    })
    await qc.invalidateQueries({ queryKey: ['annotations'] })
    closeToolbar()
    setActiveAnnId(null)
  }

  const doDelete = async () => {
    if (!activeAnnId) return
    await deleteAnnotation(activeAnnId)
    await qc.invalidateQueries({ queryKey: ['annotations'] })
    closeToolbar()
    setActiveAnnId(null)
  }

  if (!selectedPath) return null

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-0">
      {showToolbar && floating.hasAnchor && previewOverlayRef.current &&
        createPortal(
          <div
            ref={(node) => {
              toolbarRef.current = node
              ;(floating.refs.setFloating as any)?.(node)
              try { setTimeout(() => floating.update(), 0) } catch {}
            }}
            className={'z-50 w-[360px] max-w-[80vw] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-md p-3 pointer-events-auto'}
            style={{
              position: floating.strategy,
              top: floating.coordsReady ? (floating.y ?? 0) : -10000,
              left: floating.coordsReady ? (floating.x ?? 0) : -10000,
              opacity: floating.coordsReady ? 1 : 0,
              pointerEvents: floating.coordsReady ? 'auto' : 'none'
            }}
          >
            <div className="text-sm font-medium text-muted-foreground mb-2">
              {activeAnnId ? '编辑批注' : '新建批注'}
            </div>
            <Textarea
              ref={inputRef}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  if (activeAnnId) void doUpdate()
                  else void doCreate()
                }
              }}
              rows={3}
              className="mb-2"
            />
            <div className="flex items-center gap-2">
              {activeAnnId ? (
                <>
                  <button className="px-2 py-1 text-sm border rounded" onClick={doUpdate}>
                    更新
                  </button>
                  <button className="px-2 py-1 text-sm border rounded" onClick={doDelete}>
                    删除
                  </button>
                </>
              ) : (
                <button className="px-2 py-1 text-sm border rounded" onClick={doCreate}>
                  新建
                </button>
              )}
            </div>
          </div>,
          previewOverlayRef.current
        )}

      {selectedPath?.toLowerCase().endsWith('.md') ? (
        mdContent ? (
          <MarkdownPreview
            ref={previewRef}
            content={mdContent}
            annotations={(anns ?? [])
              .filter((a) => a.filePath === selectedPath)
              .map((a) => ({
                id: a.id,
                startLine: a.startLine,
                endLine: a.endLine,
                startColumn: a.startColumn,
                endColumn: a.endColumn
              }))}
            onSelectionChange={onSelectionChange}
            onOpenMark={(m, rect) => {
              setSelection({
                startLine: m.startLine,
                endLine: m.endLine,
                startColumn: m.startColumn,
                endColumn: m.endColumn,
                selectedText: ''
              })
              const id = m.id || null
              setActiveAnnId(id)
              let ann =
                (id && lastEditedRef.current.get(id)) ||
                (anns ?? []).find((a) => a.id === id)
              setComment(ann?.comment || '')
              if (rect) floating.setAnchorRect(rect)
              openToolbar()
            }}
            onAnchorChange={(r) => {
              if (showToolbar) floating.setAnchorRect(r || undefined)
            }}
            onAnchorElChange={(el) => {
              anchorElRef.current = el
              floating.setAnchorEl(el)
            }}
            onAnchorRangeChange={(range) => {
              floating.setAnchorRange(range)
            }}
            onContainerElChange={(el) => {
              previewHostRef.current = el
            }}
            onScrollElChange={(el) => {
              previewScrollRef.current = el
            }}
            onOverlayElChange={(el) => {
              previewOverlayRef.current = el
            }}
          />
        ) : (
          <div className="p-2 text-sm opacity-60">{mdError || '预览加载中...'}</div>
        )
      ) : (
        <div className="p-2 text-sm opacity-60">该文件不是 Markdown</div>
      )}
    </div>
  )
}
