import { useEffect, useMemo, useRef, useState } from 'react'
import { FloatingPortal } from '@floating-ui/react'
import { createPortal } from 'react-dom'
import { useFloatingAnnotation } from '@/components/editor/use-floating-annotation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Textarea } from '@/components/ui/textarea'
import MonacoViewer, { ViewerHandle } from '@/components/editor/MonacoViewer'
import MarkdownPreview, { PreviewHandle } from '@/components/editor/MarkdownPreview'
import MonacoEditorFull, { EditorFullHandle } from '@/components/editor/MonacoEditorFull'
import type { DirEntry } from '@/lib/api/types'
import type { AnchorRect, ViewerSelection } from '@/components/editor/types'
import {
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  listAnnotations,
  verifyAnnotations
} from '@/features/explorer/api/annotations'
import { fetchFileFull, saveFile, fetchFileChunk } from '@/features/explorer/api/files'
import type { Annotation, FileChunk } from '@/lib/api/types'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import { toast } from 'sonner'

export default function EditorPanel() {
  const qc = useQueryClient()
  const { data: anns } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })

  const { selectedPath, pageSize, wrap, toggleWrap, mdPreview, toggleMdPreview, currentDir } =
    useAppStore()
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
  const previewRef = useRef<PreviewHandle | null>(null)
  const editorRef = useRef<EditorFullHandle | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerEl, setContainerEl] = useState<HTMLElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [mdContent, setMdContent] = useState<string | null>(null)
  const [mdError, setMdError] = useState<string | null>(null)
  const lastEditedRef = useRef<Map<string, Annotation>>(new Map())
  const lastAnchorRectRef = useRef<AnchorRect | null>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)
  const previewHostRef = useRef<HTMLElement | null>(null)
  const previewScrollRef = useRef<HTMLElement | null>(null)
  const previewOverlayRef = useRef<HTMLElement | null>(null)
  const activeAnnIdRef = useRef<string | null>(null)
  // Editor 模式：锁定一次性放置方向，避免滚动/测量细微变化导致上下翻转
  const editorPlacementRef = useRef<'above' | 'below' | null>(null)
  // Editor 模式：锚点位置抗抖动（像素阈值）与上下放置的滞后（避免边界抖动）
  const editorStableRectRef = useRef<AnchorRect | null>(null)
  const STICKY_PX = 3
  const HYSTERESIS_PX = 12
  useEffect(() => {
    activeAnnIdRef.current = activeAnnId
  }, [activeAnnId])

  // 使用 floating-ui 做定位
  const [previewHostEl, setPreviewHostEl] = useState<HTMLElement | null>(null)
  const [previewScrollEl, setPreviewScrollEl] = useState<HTMLElement | null>(null)
  const [previewOverlayEl, setPreviewOverlayEl] = useState<HTMLElement | null>(null)

  // 确保容器元素在首轮渲染后进入 Hook（避免传入 null 导致初始定位异常）
  useEffect(() => {
    setContainerEl(containerRef.current)
  }, [])

  const floating = useFloatingAnnotation({
    containerEl,
    previewHostEl,
    previewScrollEl,
    mdPreview,
    show: !full && showToolbar,
    activeMarkId: activeAnnId
  })

  // 删除旧的 setVirtualReferenceFromRect，统一使用 floating.setAnchorRect / setAnchorEl

  // 预览内容加载
  useEffect(() => {
    const run = async () => {
      if (!mdPreview) {
        setMdContent(null)
        setMdError(null)
        return
      }
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
  }, [mdPreview, selectedPath])

  // 选中文件变化时复位页面态：若存在 pendingJump（来自批注跳转），避免把 startLine 重置为 1
  useEffect(() => {
    if (!pendingJump) setStartLine(1)
  }, [selectedPath, pendingJump])
  useEffect(() => {
    closeToolbar()
    setComment('')
    setSelection(null)
    // 文件切换时重置 Editor 放置方向
    editorPlacementRef.current = null
    editorStableRectRef.current = null
  }, [selectedPath])

  // 浮层聚焦：自动聚焦 textarea，并把光标置于末尾；避免引发滚动
  useEffect(() => {
    if (!showToolbar) return
    // 等待锚点就绪后再聚焦：
    // - Markdown 模式：等待 floating.x/y 可用
    // - Editor 模式：等待 floating.rect 可用
    const ready = mdPreview ? (floating.x != null && floating.y != null) : !!floating.rect
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
  }, [showToolbar, mdPreview, floating.x, floating.y, floating.rect])

  const lastVerifiedAtRef = useRef<Map<string, number>>(new Map())

  const onLoaded = (chunk: FileChunk) => {
    setChunkInfo({ start: chunk.startLine, end: chunk.endLine, total: chunk.totalLines })
    const pj = consumePendingJump()
    if (pj && selectedPath) {
      if (mdPreview) previewRef.current?.reveal?.(pj.startLine, pj.endLine)
      else viewerRef.current?.reveal?.(pj.startLine, pj.endLine, pj.startColumn, pj.endColumn)
      setSelection({
        startLine: pj.startLine,
        endLine: pj.endLine,
        selectedText: '',
        startColumn: pj.startColumn,
        endColumn: pj.endColumn
      })
      if (pj.id) setActiveAnnId(pj.id)
      if (pj.comment) setComment(pj.comment)
      // 不自动打开浮层：仅定位与高亮
    }

    // 交给后端进行权威校验与修正/清理；做一次简单节流，避免频繁分页时重复调用
    if (!selectedPath) return
    const lastAt = lastVerifiedAtRef.current.get(selectedPath) || 0
    if (Date.now() - lastAt < 1000) return
    lastVerifiedAtRef.current.set(selectedPath, Date.now())
    void (async () => {
      try {
        await verifyAnnotations({ filePath: selectedPath, window: 40, fullLimitBytes: 5 * 1024 * 1024, removeBroken: true })
        await qc.invalidateQueries({ queryKey: ['annotations'] })
      } catch {
        // 静默失败，不影响查看体验
      }
    })()
  }

  // 处理批注跳转：
  // - 若目标行在当前分片内：直接 reveal 并置顶
  // - 若不在当前分片或暂未有分片信息：调整 startLine 触发加载，onLoaded 中会 reveal
  useEffect(() => {
    if (!pendingJump || !selectedPath) return
    // Markdown 模式：不依赖分片信息，直接按行范围 reveal（等待内容就绪）
    if (mdPreview) {
      // 若预览内容尚未加载，等待后续 mdContent effect 处理
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
      return
    }
    const { startLine: s, endLine: e } = pendingJump
    const inCurrentChunk = chunkInfo ? s >= chunkInfo.start && e <= chunkInfo.end : false

    // 若当前为全文编辑模式，先退出以使用只读查看器进行定位
    if (full) {
      exitFull()
    }

    if (inCurrentChunk) {
      // 直接 reveal
      if (mdPreview) {
        previewRef.current?.reveal?.(s, e)
      } else {
        const startRel = Math.max(1, s - (chunkInfo?.start || 1) + 1)
        const endRel = Math.max(1, e - (chunkInfo?.start || 1) + 1)
        viewerRef.current?.revealModel?.(
          startRel,
          endRel,
          pendingJump.startColumn,
          pendingJump.endColumn
        )
      }
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

    // 不在当前分片或暂未加载：调整 startLine 触发加载（onLoaded 会处理 reveal）
    const safePage = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000
    setStartLine(Math.max(1, s - Math.floor(safePage / 2)))
    // 不在这里 consume，等待 onLoaded 使用最新的起始偏移 reveal
  }, [pendingJump, chunkInfo, selectedPath, mdPreview, full, pageSize, mdContent])

  const onSelectionChange = (s: ViewerSelection | null) => {
    if (showToolbar) return
    if (activeAnnId) return
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
        // 存储到全局时不带 anchorRect
        if (s.anchorRect) floating.setAnchorRect(s.anchorRect)
        setSelection({
          startLine: s.startLine,
          endLine: s.endLine,
          startColumn: s.startColumn,
          endColumn: s.endColumn,
          selectedText: s.selectedText
        })
        openToolbar()
        if (activeAnnId) setActiveAnnId(null)
        setComment('')
        // 锚点已在开关之前设置，避免初始落到 (0,0)
      }
    }
  }

  // 点击浮层外关闭（仅 Editor 模式启用；Markdown 模式默认不启用，避免滚动误关）
  useEffect(() => {
    if (!showToolbar || mdPreview) return
    const onDocMouseDown = (e: MouseEvent) => {
      const el = toolbarRef.current
      if (!el) return
      if (el.contains(e.target as Node)) return
      closeToolbar()
      viewerRef.current?.clearSelection?.()
    }
    document.addEventListener('mousedown', onDocMouseDown, false)
    return () => document.removeEventListener('mousedown', onDocMouseDown, false)
  }, [showToolbar, mdPreview, closeToolbar])

  // Editor 模式：当浮层打开或关闭时，重置放置方向，避免残留状态引发后续抖动
  useEffect(() => {
    if (!mdPreview) {
      if (!showToolbar) editorPlacementRef.current = null
    }
  }, [showToolbar, mdPreview])

  // ESC 关闭（两模式统一）
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

  // Markdown 模式：启用严格判定的“点击外部关闭”
  // 规则：仅当 pointerdown/up 无位移（<=3px）且期间未发生 scroll/wheel 时，且点击目标不在浮层内、也非命中高亮元素，才关闭。
  useEffect(() => {
    if (!showToolbar || !mdPreview) return
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
    const onAnyScroll = () => {
      if (state.down) state.scrolled = true
    }
    const onClick = (e: MouseEvent) => {
      // 仅在一次“有效无位移点击”时考虑关闭
      const shouldConsider = state.down && !state.moved && !state.scrolled && e.button === 0
      state.down = false
      if (!shouldConsider) return
      const t = e.target as HTMLElement | null
      const panel = toolbarRef.current
      if (!t || !panel) return
      // 点击在浮层内部：忽略
      if (panel.contains(t)) return
      // 点击在高亮元素：忽略（保持当前浮层）
      const hit = t.closest('[data-mark-id], .ailoom-anno-inline') as HTMLElement | null
      if (hit) return
      // 其他情况：关闭浮层
      e.preventDefault()
      e.stopPropagation()
      closeToolbar()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('pointermove', onPointerMove, true)
    document.addEventListener('pointercancel', onPointerCancel, true)
    // 捕获滚动/滚轮（包含容器与窗口），标记为“发生过滚动”
    window.addEventListener('scroll', onAnyScroll, true)
    document.addEventListener('wheel', onAnyScroll, true)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      document.removeEventListener('pointercancel', onPointerCancel, true)
      window.removeEventListener('scroll', onAnyScroll, true)
      document.removeEventListener('wheel', onAnyScroll, true)
      document.removeEventListener('click', onClick, true)
    }
  }, [showToolbar, mdPreview, closeToolbar])

  const doCreate = async () => {
    if (!selectedPath || !selection) return
    if (!comment.trim()) return
    const selText = (() => {
      if (mdPreview && mdContent) {
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
      if (mdPreview && mdContent) {
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

  // 目录树缓存（用于显示当前文件大小）
  const treeCached = qc.getQueryData(['tree', currentDir]) as DirEntry[] | undefined

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">
      {/* 批注操作块移除：导出/导入下线，“生成并复制”移动到批注面板标题行 */}
      {!selectedPath && <div className="text-sm opacity-70">选择左侧的文件以查看内容</div>}
      {selectedPath && (
        <>
          <div className="shrink-0 flex items-center justify-between text-sm px-2 py-1">
            <div>
              <span className="opacity-70 mr-2">文件:</span>
              <code className="px-1.5 py-0.5 bg-black/5 rounded">{selectedPath}</code>
              {chunkInfo && (
                <span className="ml-2 opacity-60">
                  L{chunkInfo.start}-{chunkInfo.end}/{chunkInfo.total}
                </span>
              )}
              {(() => {
                const size = treeCached?.find((e) => e.path === selectedPath)?.size
                if (size == null) return null
                const human =
                  size < 1024
                    ? size + 'B'
                    : size < 1024 * 1024
                      ? (size / 1024).toFixed(1) + 'KB'
                      : (size / 1024 / 1024).toFixed(1) + 'MB'
                return <span className="ml-2 opacity-60">{human}</span>
              })()}
            </div>
            <div className="flex items-center gap-2">
              {!full && (
                <button className="px-2 py-1 border rounded" onClick={toggleWrap}>
                  {wrap ? '关闭换行' : '自动换行'}
                </button>
              )}
              {selectedPath?.toLowerCase().endsWith('.md') && !full && (
                <button className="px-2 py-1 border rounded" onClick={toggleMdPreview}>
                  {mdPreview ? '关闭预览' : '预览'}
                </button>
              )}
              {(treeCached?.find((e) => e.path === selectedPath)?.size ?? 0) <= 512000 && (
                <button
                  className="px-2 py-1 border rounded"
                  onClick={async () => {
                    try {
                      const f = await fetchFileFull(selectedPath)
                      enterFull({ content: f.content, language: f.language, digest: f.digest })
                      setSelection(null)
                    } catch (err: any) {
                      const msg = String(err?.message || '')
                      if (msg.startsWith('OVER_LIMIT') || msg.startsWith('HTTP_413')) {
                        toast.error('文件过大，无法全量读取')
                      } else if (msg.includes('NON_TEXT') || msg.startsWith('HTTP_415')) {
                        toast.error('该文件不是可预览的文本')
                      } else {
                        toast.error('进入编辑失败：' + msg)
                      }
                    }
                  }}
                >
                  进入编辑
                </button>
              )}
            </div>
          </div>
          <div ref={containerRef} className="relative flex-1 min-h-0">
            {!full && showToolbar && (
              mdPreview ? (
                // 仅在 Markdown 锚点就绪后再挂载浮层，避免首帧错误坐标闪烁
                (floating.hasAnchor && previewOverlayEl && (
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
                      // 首帧 gating：坐标未就绪前放到屏幕外并透明，避免错误坐标闪烁
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
                    {/* 取消按钮移除：点击外部区域可关闭 */}
                  </div>
                  </div>,
                  previewOverlayEl
                )
                ))
              ) : (
                <div
                  ref={toolbarRef}
                  className={`absolute z-50 w-[360px] max-w-[80vw] rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-md p-3`}
                  style={{
                    left: (() => {
                      const cont = containerRef.current?.getBoundingClientRect()
                      // 稳定化锚点坐标，减少微小抖动
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
                      return Math.max(0, r.x - cont.left)
                    })(),
                    top: (() => {
                      const cont = containerRef.current?.getBoundingClientRect()
                      // 使用稳定化后的锚点
                      const r = editorStableRectRef.current
                      const h = toolbarRef.current?.offsetHeight || 0
                      const gap = 8
                      if (!cont || !r || h <= 0) return -10000
                      if (!editorPlacementRef.current) {
                        // 初次决定放置方向：优先上方，空间不足则下方；决定后在本次打开周期内不翻转
                        const spaceAbove = r.y - cont.top
                        // 引入滞后：需要比实际高度多出一定余量，才选择上方，避免边界抖动
                        editorPlacementRef.current = spaceAbove >= h + gap + HYSTERESIS_PX ? 'above' : 'below'
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
                  {/* 取消按钮移除：点击外部区域可关闭 */}
                </div>
                </div>
              )
            )}

            {!full ? (
              <>
                {mdPreview && selectedPath?.toLowerCase().endsWith('.md') ? (
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
                      onSelectionChange={(s: ViewerSelection | null) => {
                        if (showToolbar) return
                        if (!s) {
                          onSelectionChange(null)
                          return
                        }
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
                      }}
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
                      setPreviewHostEl(el)
                    }}
                    onScrollElChange={(el) => {
                      previewScrollRef.current = el
                      setPreviewScrollEl(el)
                    }}
                    onOverlayElChange={(el) => {
                      previewOverlayRef.current = el
                      setPreviewOverlayEl(el)
                    }}
                  />
                ) : (
                    <div className="p-2 text-sm opacity-60">{mdError || '预览加载中...'}</div>
                  )
                ) : (
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
                      if (rect) floating.setAnchorRect(rect)
                    }}
                    wrap={wrap}
                  />
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    className="px-2 py-1 text-sm border rounded"
                    onClick={async () => {
                      if (!selectedPath || !full) return
                      const content = editorRef.current?.getValue() || full.content
                      try {
                        const r = await saveFile({
                          path: selectedPath,
                          content,
                          baseDigest: full.digest
                        })
                        if (r.ok) {
                          enterFull({ ...full, content, digest: r.digest || full.digest })
                        }
                      } catch (err: any) {
                        const msg = String(err?.message || '')
                        if (msg.startsWith('CONFLICT:'))
                          toast.error('保存冲突：文件已被外部修改，请刷新内容后再试')
                        else toast.error('保存失败：' + msg)
                      }
                    }}
                  >
                    保存(Ctrl/⌘S)
                  </button>
                  <button className="px-2 py-1 text-sm border rounded" onClick={() => exitFull()}>
                    退出编辑
                  </button>
                </div>
                <MonacoEditorFull
                  ref={editorRef}
                  content={full.content}
                  language={full.language}
                  editable
                  onSave={async (content) => {
                    if (!selectedPath || !full) return
                    try {
                      const r = await saveFile({
                        path: selectedPath,
                        content,
                        baseDigest: full.digest
                      })
                      if (r.ok) {
                        enterFull({ ...full, content, digest: r.digest || full.digest })
                      }
                    } catch (err: any) {
                      const msg = String(err?.message || '')
                      if (msg.startsWith('CONFLICT:'))
                        toast.error('保存冲突：文件已被外部修改，请刷新内容后再试')
                      else toast.error('保存失败：' + msg)
                    }
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
