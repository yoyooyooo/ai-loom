import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import MarkdownPreview, { PreviewHandle } from '@/components/editor/MarkdownPreview'
import { Textarea } from '@/components/ui/textarea'
import type { ViewerSelection } from '@/components/editor/types'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listAnnotations,
  createAnnotation,
  updateAnnotation,
  deleteAnnotation
} from '@/features/explorer/api/annotations'
import { fetchFileFull } from '@/features/explorer/api/files'
import { ws } from '@/lib/ws/singleton'
import type { FileChangedPayload } from '@/lib/ws/event-payloads'
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
  // Markdown 绝对定位放置方向与抖动抑制
  const mdPlacementRef = useRef<'above' | 'below' | null>(null)
  const mdStableRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(
    null
  )
  const MD_STICKY_PX = 3
  const MD_STABLE_MIN_FRAMES = 2
  // 首帧门控：仅在进入一帧 rAF 后再允许显示，避免首帧跳动可见
  const mdFirstFrameReadyRef = useRef(false)
  const [mdGateTick, setMdGateTick] = useState(0)
  const mdStableStateRef = useRef<{
    lastX: number
    lastY: number
    place: 'above' | 'below' | null
    consecutive: number
  }>({ lastX: 0, lastY: 0, place: null, consecutive: 0 })

  useEffect(() => {
    if (!showToolbar) {
      mdPlacementRef.current = null
      mdStableRectRef.current = null
      mdStableStateRef.current = { lastX: 0, lastY: 0, place: null, consecutive: 0 }
      mdFirstFrameReadyRef.current = false
    }
  }, [showToolbar])

  // 首帧仅延后一帧再显示，避免初始测量/翻转尚未稳定导致的可见闪烁
  // 注意：依赖 floating.hasAnchor，必须在 floating 定义之后声明此 effect

  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setContainerEl(containerRef.current)
  }, [])

  const floating = useMarkdownFloatingAnnotation({
    containerEl,
    previewHostEl: previewHostRef.current,
    previewScrollEl: previewScrollRef.current,
    show: showToolbar,
    activeMarkId: activeAnnId
  })

  // 首帧仅延后一帧再显示，避免初始测量/翻转尚未稳定导致的可见闪烁
  useEffect(() => {
    if (!showToolbar) return
    if (!floating.hasAnchor) return
    mdFirstFrameReadyRef.current = false
    try {
      requestAnimationFrame(() => {
        mdFirstFrameReadyRef.current = true
        setMdGateTick((v) => v + 1)
      })
    } catch {}
  }, [showToolbar, floating.hasAnchor])

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
        // WS 路径返回 MESSAGE_TOO_LARGE；REST 返回 HTTP_413
        if (
          msg.startsWith('OVER_LIMIT') ||
          msg.includes('MESSAGE_TOO_LARGE') ||
          msg.startsWith('HTTP_413')
        ) {
          setMdError('预览不可用：文件过大，无法全量读取')
        } else if (msg.includes('NON_TEXT') || msg.startsWith('HTTP_415')) {
          setMdError('预览不可用：该文件不是文本')
        } else if (msg.includes('INVALID_PATH') || msg.startsWith('HTTP_400')) {
          setMdError('预览不可用：文件不存在或路径无效')
        } else {
          setMdError('预览加载失败')
        }
      }
    }
    run()
  }, [selectedPath])

  // 监听 file.changed：当前为 Markdown 预览时，自动刷新预览内容（不覆盖其它模式逻辑）
  useEffect(() => {
    if (!selectedPath || !selectedPath.toLowerCase().endsWith('.md')) return
    const sub = ws.notification$('file.changed').subscribe(async (p: FileChangedPayload) => {
      try {
        const path = String(p?.path || '')
        if (!path || path !== selectedPath) return
        const f = await fetchFileFull(selectedPath)
        setMdContent(f.content)
        setMdError(null)
      } catch (e: any) {
        // 保持原有错误映射
        const msg = String(e?.message || '')
        if (
          msg.startsWith('OVER_LIMIT') ||
          msg.includes('MESSAGE_TOO_LARGE') ||
          msg.startsWith('HTTP_413')
        )
          setMdError('预览不可用：文件过大，无法全量读取')
        else if (msg.includes('NON_TEXT') || msg.startsWith('HTTP_415'))
          setMdError('预览不可用：该文件不是文本')
        else if (msg.includes('INVALID_PATH') || msg.startsWith('HTTP_400'))
          setMdError('预览不可用：文件不存在或路径无效')
        else setMdError('预览加载失败')
      }
    })
    return () => {
      try {
        sub.unsubscribe()
      } catch {}
    }
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
        try {
          el.focus()
        } catch {}
      }
      try {
        const len = el.value?.length ?? 0
        el.setSelectionRange(len, len)
      } catch {}
    }, 0)
  }, [showToolbar, floating.x, floating.y])

  // 首帧定位健壮性：在打开浮层且拿到锚点后，主动触发两次 update，避免首帧落在 (0,0)
  useEffect(() => {
    if (!showToolbar) return
    if (!floating.hasAnchor) return
    try {
      setTimeout(() => {
        try {
          if ((window as any)?.localStorage?.getItem('AILOOM_DEBUG_MD_FLOAT'))
            console.log('[md-float] panel: setTimeout update')
          floating.update()
        } catch {}
      }, 0)
    } catch {}
    try {
      requestAnimationFrame(() => {
        try {
          if ((window as any)?.localStorage?.getItem('AILOOM_DEBUG_MD_FLOAT'))
            console.log('[md-float] panel: rAF update')
          floating.update()
        } catch {}
      })
    } catch {}
  }, [showToolbar, floating.hasAnchor])

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
    const onPointerCancel = () => {
      state.scrolled = true
    }
    const onAnyScroll = () => {
      if (state.down) state.scrolled = true
    }
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
    try {
      if ((window as any)?.localStorage?.getItem('AILOOM_DEBUG_MD_FLOAT'))
        console.log('[md-float] panel:onSelectionChange', s)
    } catch {}
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
      {showToolbar &&
        floating.hasAnchor &&
        previewOverlayRef.current &&
        createPortal(
          <div
            ref={(node) => {
              toolbarRef.current = node
              ;(floating.refs.setFloating as any)?.(node)
              try {
                setTimeout(() => floating.update(), 0)
              } catch {}
            }}
            className={
              'z-50 w-[360px] max-w-[80vw] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-md p-3 pointer-events-auto'
            }
            style={{
              position: floating.strategy,
              top: (() => {
                if (floating.strategy === 'absolute') {
                  const overlay = previewOverlayRef.current?.getBoundingClientRect()
                  const viewport = previewScrollRef.current?.getBoundingClientRect()
                  const cur = floating.rect
                  const h = toolbarRef.current?.offsetHeight || 0
                  const gap = 8
                  if (!overlay || !viewport || !cur || h <= 0) return -10000
                  // 抖动抑制：小范围变化保持上一帧
                  const prev = mdStableRectRef.current
                  let r = prev || cur
                  if (prev) {
                    const dx = Math.abs(cur.x - prev.x)
                    const dy = Math.abs(cur.y - prev.y)
                    if (dx > MD_STICKY_PX || dy > MD_STICKY_PX) {
                      mdStableRectRef.current = cur
                      r = cur
                    }
                  } else {
                    mdStableRectRef.current = cur
                  }
                  // 翻转依据“视口”空间
                  const spaceAbove = r.y - viewport.top
                  const spaceBelow = viewport.bottom - (r.y + (r.height || 0))
                  const needAbove = spaceAbove >= h + gap + 12
                  const needBelow = spaceBelow >= h + gap + 12
                  mdPlacementRef.current == null &&
                    (mdPlacementRef.current = needAbove ? 'above' : 'below')
                  if (mdPlacementRef.current === 'above') {
                    if (!needAbove && needBelow) mdPlacementRef.current = 'below'
                    else if (!needAbove && !needBelow)
                      mdPlacementRef.current = spaceBelow > spaceAbove ? 'below' : 'above'
                  } else {
                    if (!needBelow && needAbove) mdPlacementRef.current = 'above'
                    else if (!needBelow && !needAbove)
                      mdPlacementRef.current = spaceAbove > spaceBelow ? 'above' : 'below'
                  }
                  const place = mdPlacementRef.current
                  // 首帧稳定：需要连续两帧得到相同的 place 与近似坐标后再显示
                  try {
                    const st = mdStableStateRef.current
                    if (
                      st.place === place &&
                      Math.abs(st.lastX - r.x) < 1 &&
                      Math.abs(st.lastY - r.y) < 1
                    )
                      st.consecutive += 1
                    else st.consecutive = 1
                    st.place = place
                    st.lastX = r.x
                    st.lastY = r.y
                  } catch {}
                  // 定位依据“overlay”坐标系
                  return place === 'above'
                    ? r.y - overlay.top - h - gap
                    : r.y - overlay.top + (r.height || 0) + gap
                }
                return floating.coordsReady ? (floating.y ?? 0) : -10000
              })(),
              left: (() => {
                if (floating.strategy === 'absolute') {
                  const overlay = previewOverlayRef.current?.getBoundingClientRect()
                  const r = mdStableRectRef.current || floating.rect
                  const w = toolbarRef.current?.offsetWidth || 0
                  if (!overlay || !r) return -10000
                  const overlayWidth = Math.max(0, overlay.right - overlay.left)
                  const left = r.x - overlay.left
                  return Math.min(Math.max(0, left), Math.max(0, overlayWidth - w))
                }
                return floating.coordsReady ? (floating.x ?? 0) : -10000
              })(),
              opacity: (() => {
                if (floating.strategy === 'absolute') {
                  const h = toolbarRef.current?.offsetHeight || 0
                  const ok =
                    h > 0 &&
                    mdFirstFrameReadyRef.current &&
                    mdStableStateRef.current.consecutive >= MD_STABLE_MIN_FRAMES
                  return ok ? 1 : 0
                }
                return floating.coordsReady ? 1 : 0
              })(),
              pointerEvents: (() => {
                if (floating.strategy === 'absolute') {
                  const h = toolbarRef.current?.offsetHeight || 0
                  const ok =
                    h > 0 &&
                    mdFirstFrameReadyRef.current &&
                    mdStableStateRef.current.consecutive >= MD_STABLE_MIN_FRAMES
                  return ok ? 'auto' : 'none'
                }
                return floating.coordsReady ? 'auto' : 'none'
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
              try {
                if ((window as any)?.localStorage?.getItem('AILOOM_DEBUG_MD_FLOAT'))
                  console.log('[md-float] panel:onOpenMark', { m, rect })
              } catch {}
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
                (id && lastEditedRef.current.get(id)) || (anns ?? []).find((a) => a.id === id)
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
