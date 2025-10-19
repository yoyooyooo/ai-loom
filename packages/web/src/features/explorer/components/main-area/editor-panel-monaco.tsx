import { useEffect, useRef, useState } from 'react'
import MonacoViewer, { ViewerHandle } from '@/components/editor/MonacoViewer'
import { Textarea } from '@/components/ui/textarea'
import type { AnchorRect, ViewerSelection } from '@/components/editor/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAnnotations, verifyAnnotations, createAnnotation, updateAnnotation, deleteAnnotation } from '@/features/explorer/api/annotations'
import { fetchFileChunk } from '@/features/explorer/api/files'
import type { Annotation, FileChunk } from '@/lib/api/types'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import { useEditorFloatingAnchor } from '@/components/editor/use-editor-floating-anchor'
import { toast } from 'sonner'

export default function EditorPanelMonaco() {
  const qc = useQueryClient()
  const { data: anns } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })

  const { selectedPath, pageSize, wrap } = useAppStore()
  const {
    startLine,
    setStartLine,
    selection,
    setSelection,
    showToolbar,
    openToolbar,
    closeToolbar,
    comment,
    setComment,
    activeAnnId,
    setActiveAnnId,
    full,
    enterFull,
    exitFull,
    chunkInfo,
    setChunkInfo,
    consumePendingJump,
    revealNonce,
    pendingJump
  } = useExplorerStore()

  const viewerRef = useRef<ViewerHandle | null>(null)
  const editorRef = useRef<any>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const lastEditedRef = useRef<Map<string, Annotation>>(new Map())
  const activeAnnIdRef = useRef<string | null>(null)
  const [toolbarMeasureTick, setToolbarMeasureTick] = useState(0)

  // Editor 模式：锁定一次性放置方向，避免滚动/测量细微变化导致上下翻转
  const editorPlacementRef = useRef<'above' | 'below' | null>(null)
  // Editor 模式：锚点位置抗抖动（像素阈值）与上下放置的滞后（避免边界抖动）
  const editorStableRectRef = useRef<AnchorRect | null>(null)
  const STICKY_PX = 3
  const HYSTERESIS_PX = 12
  useEffect(() => {
    activeAnnIdRef.current = activeAnnId
  }, [activeAnnId])

  const floating = useEditorFloatingAnchor({ show: !full && showToolbar })

  // 浮层聚焦
  useEffect(() => {
    if (!showToolbar) return
    const ready = !!floating.rect
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
  }, [showToolbar, floating.rect])

  const lastVerifiedAtRef = useRef<Map<string, number>>(new Map())

  const onLoaded = (chunk: FileChunk) => {
    setChunkInfo({ start: chunk.startLine, end: chunk.endLine, total: chunk.totalLines })
    const pj = consumePendingJump()
    if (pj && selectedPath) {
      viewerRef.current?.reveal?.(pj.startLine, pj.endLine, pj.startColumn, pj.endColumn)
      setSelection({
        startLine: pj.startLine,
        endLine: pj.endLine,
        selectedText: '',
        startColumn: pj.startColumn,
        endColumn: pj.endColumn
      })
      if (pj.id) setActiveAnnId(pj.id)
      if (pj.comment) setComment(pj.comment)
    }
    if (!selectedPath) return
    const lastAt = lastVerifiedAtRef.current.get(selectedPath) || 0
    if (Date.now() - lastAt < 1000) return
    lastVerifiedAtRef.current.set(selectedPath, Date.now())
    void (async () => {
      try {
        await verifyAnnotations({ filePath: selectedPath, window: 40, fullLimitBytes: 5 * 1024 * 1024, removeBroken: true })
        await qc.invalidateQueries({ queryKey: ['annotations'] })
      } catch {}
    })()
  }

  // 处理批注跳转
  useEffect(() => {
    if (!pendingJump || !selectedPath) return
    const { startLine: s, endLine: e } = pendingJump
    const inCurrentChunk = chunkInfo ? s >= chunkInfo.start && e <= chunkInfo.end : false
    if (full) exitFull()
    if (inCurrentChunk) {
      const startRel = Math.max(1, s - (chunkInfo?.start || 1) + 1)
      const endRel = Math.max(1, e - (chunkInfo?.start || 1) + 1)
      viewerRef.current?.revealModel?.(startRel, endRel, pendingJump.startColumn, pendingJump.endColumn)
      setSelection({
        startLine: s,
        endLine: e,
        selectedText: '',
        startColumn: pendingJump.startColumn,
        endColumn: pendingJump.endColumn
      })
      if (pendingJump.id) setActiveAnnId(pendingJump.id)
      if (pendingJump.comment) setComment(pendingJump.comment)
      // 不自动打开浮层：仅定位与高亮
      consumePendingJump()
      return
    }
    const safePage = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000
    setStartLine(Math.max(1, s - Math.floor(safePage / 2)))
  }, [pendingJump, chunkInfo, selectedPath, full, pageSize])

  const onSelectionChange = (s: ViewerSelection | null) => {
    if (showToolbar) return
    if (
      toolbarRef.current &&
      document.activeElement &&
      toolbarRef.current.contains(document.activeElement)
    )
      return
    if (s) {
      const prev = selection
      const changed =
        !prev ||
        prev.startLine !== s.startLine ||
        prev.endLine !== s.endLine ||
        prev.startColumn !== s.startColumn ||
        prev.endColumn !== s.endColumn
      if (changed) {
        if (s.anchorRect) floating.setAnchorRect(s.anchorRect)
        if (activeAnnId) setActiveAnnId(null)
        // 将模型相对行号换算为文件绝对行号，保证与 Markdown 模式一致
        const base = (chunkInfo?.start || 1)
        const absStart = base + (s.startLine || 1) - 1
        const absEnd = base + (s.endLine || 1) - 1
        setSelection({
          startLine: absStart,
          endLine: absEnd,
          startColumn: s.startColumn,
          endColumn: s.endColumn,
          selectedText: s.selectedText
        })
        openToolbar()
        setComment('')
      }
    }
  }

  // 点击浮层外关闭
  useEffect(() => {
    if (!showToolbar) return
    const onDocMouseDown = (e: MouseEvent) => {
      const el = toolbarRef.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      closeToolbar()
      try { viewerRef.current?.clearSelection?.() } catch {}
    }
    document.addEventListener('mousedown', onDocMouseDown, false)
    return () => document.removeEventListener('mousedown', onDocMouseDown, false)
  }, [showToolbar, closeToolbar])

  // ESC 关闭
  useEffect(() => {
    if (!showToolbar) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeToolbar()
        try { viewerRef.current?.clearSelection?.() } catch {}
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [showToolbar, closeToolbar])

  const doCreate = async () => {
    if (!selectedPath || !selection) return
    if (!comment.trim()) return
    const created = await createAnnotation({
      filePath: selectedPath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      selectedText: selection.selectedText,
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
    const updated = await updateAnnotation(activeAnnId, {
      filePath: selectedPath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      startColumn: selection.startColumn,
      endColumn: selection.endColumn,
      selectedText: selection.selectedText,
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
      {!showToolbar ? null : (
        <div
          ref={(node) => {
            toolbarRef.current = node
            if (node) {
              requestAnimationFrame(() => setToolbarMeasureTick((n) => n + 1))
            }
          }}
          className={`absolute z-50 w-[360px] max-w-[80vw] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-md p-3`}
          style={{
            opacity: (() => {
              const h = toolbarRef.current?.offsetHeight || 0
              return h > 0 ? 1 : 0
            })(),
            pointerEvents: (() => {
              const h = toolbarRef.current?.offsetHeight || 0
              return h > 0 ? 'auto' : 'none'
            })(),
            left: (() => {
              const cont = containerRef.current?.getBoundingClientRect()
              const cur = floating.rect
              const prev = editorStableRectRef.current
              let r = prev || cur || null
              if (cur) {
                if (!prev) editorStableRectRef.current = cur
                else {
                  const dx = Math.abs(cur.x - prev.x)
                  const dy = Math.abs(cur.y - prev.y)
                  if (dx > STICKY_PX || dy > STICKY_PX) {
                    editorStableRectRef.current = cur
                    r = cur
                  } else {
                    r = prev
                  }
                }
              }
              if (!cont || !r) return -10000
              const contWidth = Math.max(0, cont.right - cont.left)
              const w = toolbarRef.current?.offsetWidth || 0
              const left = r.x - cont.left
              return Math.min(Math.max(0, left), Math.max(0, contWidth - w))
            })(),
            top: (() => {
              const cont = containerRef.current?.getBoundingClientRect()
              const r = editorStableRectRef.current
              const h = toolbarRef.current?.offsetHeight || 0
              const gap = 8
              if (!cont || !r) return -10000
              if (h <= 0) return -10000
              const spaceAbove = r.y - cont.top
              const spaceBelow = cont.bottom - (r.y + (r.height || 0))
              const needAbove = spaceAbove >= h + gap + HYSTERESIS_PX
              const needBelow = spaceBelow >= h + gap + HYSTERESIS_PX
              if (!editorPlacementRef.current) {
                editorPlacementRef.current = needAbove ? 'above' : 'below'
              } else {
                if (editorPlacementRef.current === 'above') {
                  if (!needAbove && needBelow) editorPlacementRef.current = 'below'
                  else if (!needAbove && !needBelow) editorPlacementRef.current = spaceBelow > spaceAbove ? 'below' : 'above'
                } else {
                  if (!needBelow && needAbove) editorPlacementRef.current = 'above'
                  else if (!needBelow && !needAbove) editorPlacementRef.current = spaceAbove > spaceBelow ? 'above' : 'below'
                }
              }
              const place = editorPlacementRef.current
              if (place === 'above') return r.y - cont.top - h - gap
              return r.y - cont.top + (r.height || 0) + gap
            })()
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
        </div>
      )}

      <MonacoViewer
        ref={viewerRef}
        path={selectedPath}
        startLine={startLine}
        maxLines={pageSize}
        reloadToken={revealNonce}
        topPadLines={3}
        fetchChunk={fetchFileChunk}
        onLoaded={onLoaded}
        onSelectionChange={onSelectionChange}
        onAnchorChange={(r) => {
          if (showToolbar) floating.setAnchorRect(r || undefined)
        }}
        marks={(anns ?? [])
          .filter((a) => a.filePath === selectedPath)
          .map((a) => ({
            id: a.id,
            startLine: a.startLine,
            endLine: a.endLine,
            startColumn: a.startColumn,
            endColumn: a.endColumn
          }))}
        onOpenMark={(m, rect) => {
          if (rect) {
            editorStableRectRef.current = rect
            editorPlacementRef.current = null
            floating.setAnchorRect(rect)
          }
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
          openToolbar()
        }}
        wrap={wrap}
      />
    </div>
  )
}
