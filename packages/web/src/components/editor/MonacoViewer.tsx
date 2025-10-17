import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import * as monaco from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import '@/styles/monaco-overrides.css'
import { useQuery } from '@tanstack/react-query'
import type { FileChunk } from '@/lib/api/types'
import type { AnchorRect, ViewerSelection } from '@/components/editor/types'
import { ANCHOR_LEFT_TWEAK } from '@/components/editor/constants'

export type ViewerHandle = {
  // 以“文件绝对行号”定位
  reveal: (
    startLine: number,
    endLine: number,
    startColumn?: number,
    endColumn?: number
  ) => void
  // 以“当前模型行号”（1-based）定位（避免偏移不同步问题）
  revealModel: (
    startLineRel: number,
    endLineRel: number,
    startColumn?: number,
    endColumn?: number
  ) => void
  clearSelection: () => void
}

type Props = {
  path: string
  startLine: number
  maxLines: number
  reloadToken?: number
  fetchChunk: (args: { path: string; startLine: number; maxLines: number }) => Promise<FileChunk>
  onLoaded?: (chunk: FileChunk) => void
  onSelectionChange?: (sel: ViewerSelection | null) => void
  marks?: {
    id?: string
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
  }[]
  onOpenMark?: (mark: {
    id?: string
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
  }, anchorRect?: AnchorRect) => void
  wrap?: boolean
  topPadLines?: number
  onAnchorChange?: (rect: AnchorRect | null) => void
}

const MonacoViewer = forwardRef<ViewerHandle, Props>(function MonacoViewer(
  {
    path,
    startLine,
    maxLines,
    reloadToken,
    fetchChunk,
    onLoaded,
    onSelectionChange,
    marks,
    onOpenMark,
    wrap,
    topPadLines = 3,
    onAnchorChange
  },
  fref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const decoMapRef = useRef<
    Map<
      string,
      { id?: string; startLine: number; endLine: number; startColumn?: number; endColumn?: number }
    >
  >(new Map())
  const endRef = useRef(0)
  const totalRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const loadingEarlierRef = useRef(false)
  const suppressAutoLoadUntilRef = useRef(0)
  const isJumpingRef = useRef(false)
  const initialStartRef = useRef(startLine)
  const pendingInitialRef = useRef<FileChunk | null>(null)

  const safeStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1
  const safeMax = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 1000
  const queryKey = useMemo(
    () => ['file', path, safeStart, safeMax, reloadToken ?? 0],
    [path, safeStart, safeMax, reloadToken]
  )
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => fetchChunk({ path, startLine: safeStart, maxLines: safeMax }),
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false
  })

  const draggingRef = useRef(false)
  const onSelRef = useRef<typeof onSelectionChange | undefined>(onSelectionChange)
  const onOpenMarkRef = useRef<typeof onOpenMark | undefined>(onOpenMark)
  const onAnchorChangeRef = useRef<typeof onAnchorChange | undefined>(onAnchorChange)
  const onLoadedRef = useRef<typeof onLoaded | undefined>(onLoaded)
  const lastMarkRangeRef = useRef<monaco.Range | null>(null)

  useEffect(() => {
    onSelRef.current = onSelectionChange
  }, [onSelectionChange])
  useEffect(() => {
    onOpenMarkRef.current = onOpenMark
  }, [onOpenMark])
  useEffect(() => {
    onLoadedRef.current = onLoaded
  }, [onLoaded])
  useEffect(() => {
    onAnchorChangeRef.current = onAnchorChange
  }, [onAnchorChange])
  const suppressSelectionOnceRef = useRef(false)
  const suppressSelectionUntilRef = useRef(0)
  const blockHitRef = useRef(false)
  const lastAnchorFromMarkRef = useRef<
    | { lineNumber: number; column: number; height: number }
    | null
  >(null)

  const computeAnchorForRange = (
    ed: monaco.editor.IStandaloneCodeEditor,
    rng: monaco.Range
  ): AnchorRect | null => {
    try {
      const host = containerRef.current
      const rect = host?.getBoundingClientRect()
      if (!rect) return null
      const pStart = ed.getScrolledVisiblePosition({ lineNumber: rng.startLineNumber, column: rng.startColumn } as any)
      const pEnd = ed.getScrolledVisiblePosition({ lineNumber: rng.endLineNumber, column: rng.endColumn } as any)
      const li = ed.getLayoutInfo?.()
      const contentLeft = (li && (li as any).contentLeft) || 0
      if (!pStart) return null
      const top = rect.top + pStart.top
      const left = rect.left + contentLeft + ANCHOR_LEFT_TWEAK
      const bottom = pEnd ? rect.top + pEnd.top + (pEnd.height || 0) : top + (pStart.height || 18)
      const height = Math.max(1, bottom - top)
      return { x: left, y: top, width: 1, height }
    } catch {
      return null
    }
  }

  useEffect(() => {
    if (!containerRef.current) return
    if (!editorRef.current) {
      editorRef.current = monaco.editor.create(containerRef.current, {
        value: '',
        language: 'plaintext',
        readOnly: true,
        theme: 'vs',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        wordWrap: wrap ? 'on' : 'off',
        // 关闭默认的词/匹配高亮与括号配对边框，减少只读状态的干扰
        occurrencesHighlight: false,
        selectionHighlight: false,
        matchBrackets: 'never',
        bracketPairColorization: { enabled: false } as any,
        guides: { bracketPairs: false } as any
      })
      // 在按下时命中注解则拦截默认行为，只弹出浮层且不改变光标
      editorRef.current.onMouseDown((e) => {
        draggingRef.current = true
        blockHitRef.current = false
        const ed = editorRef.current!
        const model = ed.getModel()
        if (onOpenMark && model) {
          const be: any = (e as any)?.event?.browserEvent
          const tgt = be ? (ed as any).getTargetAtClientPoint?.(be.clientX, be.clientY) : null
          const pos = e?.target?.position || tgt?.position || ed.getPosition()
          if (pos) {
            const hits =
              model.getDecorationsInRange(
                new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
              ) || []
            for (const d of hits) {
              const m = (decoMapRef.current as any)?.get?.(d.id)
              if (m) {
                try {
                  ;(e as any)?.event?.preventDefault?.()
                  ;(e as any)?.event?.stopPropagation?.()
                } catch {}
                suppressSelectionOnceRef.current = true
                suppressSelectionUntilRef.current = Date.now() + 1000
                blockHitRef.current = true
                draggingRef.current = false
                // 基于命中装饰的首行作为锚点，避免被浮层遮挡
                const anchor = computeAnchorForRange(ed, d.range)
                if (anchor) {
                  onAnchorChangeRef.current?.(anchor)
                  lastMarkRangeRef.current = d.range
                }
                onOpenMarkRef.current?.(m, anchor || undefined)
                return
              }
            }
          }
        }
      })
      editorRef.current.onMouseUp((e) => {
        draggingRef.current = false
        const ed = editorRef.current!
        const model = ed.getModel()
        if (blockHitRef.current) {
          try {
            ;(e as any)?.event?.preventDefault?.()
            ;(e as any)?.event?.stopPropagation?.()
          } catch {}
          blockHitRef.current = false
          return
        }
        // 1) 单击命中注解范围：优先回显弹框（避免被“空选择”覆盖）
        if (onOpenMark) {
          const be: any = (e as any)?.event?.browserEvent
          const tgt = be ? (ed as any).getTargetAtClientPoint?.(be.clientX, be.clientY) : null
          const pos = e?.target?.position || tgt?.position || ed.getPosition()
          const offset = initialStartRef.current
          if (pos && model) {
            const hits =
              model.getDecorationsInRange(
                new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
              ) || []
            for (const d of hits) {
              const m = (decoMapRef.current as any)?.get?.(d.id)
              if (m) {
                // 稳定回显
                suppressSelectionOnceRef.current = true
                suppressSelectionUntilRef.current = Date.now() + 1000
                // 使用装饰范围首行定位
                const anchor = computeAnchorForRange(ed, d.range)
                if (anchor) {
                  onAnchorChangeRef.current?.(anchor)
                  lastMarkRangeRef.current = d.range
                }
                onOpenMarkRef.current?.(m, anchor || undefined)
                return
              }
            }
          }
        }
        // 2) 常规选择回调
        if (Date.now() < suppressSelectionUntilRef.current) return
        const sel = ed.getSelection()
        if (!sel || sel.isEmpty() || !model) {
          onSelectionChange?.(null)
          return
        }
        const start = Math.min(sel.startLineNumber, sel.endLineNumber)
        const end = Math.max(sel.startLineNumber, sel.endLineNumber)
        const startCol = sel.startLineNumber <= sel.endLineNumber ? sel.startColumn : sel.endColumn
        const endCol = sel.startLineNumber <= sel.endLineNumber ? sel.endColumn : sel.startColumn
        const text = model.getValueInRange(sel)
        const rng = new monaco.Range(start, startCol, end, endCol)
        const anchor = computeAnchorForRange(ed, rng)
        if (anchor) onAnchorChangeRef.current?.(anchor)
        onSelRef.current?.({
          startLine: start,
          endLine: end,
          startColumn: startCol,
          endColumn: endCol,
          selectedText: text,
          anchorRect: anchor || undefined
        })
        // 若有延迟的初次数据待应用，则在鼠标释放后再应用，避免中断选择
        if (pendingInitialRef.current) {
          const pending = pendingInitialRef.current
          pendingInitialRef.current = null
          const st2 = ed.saveViewState()
          const m2 = ed.getModel() ?? monaco.editor.createModel('', pending.language)
          if (ed.getModel() == null) ed.setModel(m2)
          m2.setValue(pending.content)
          monaco.editor.setModelLanguage(m2, pending.language || 'plaintext')
          ed.restoreViewState(st2)
          endRef.current = pending.endLine
          totalRef.current = pending.totalLines
          // 使用真实数据的起始行，避免服务端裁剪/纠正导致的偏移不一致
          initialStartRef.current = pending.startLine
          onLoadedRef.current?.(pending)
        }
      })
      // 键盘选区也需要回调
      editorRef.current.onDidChangeCursorSelection((e) => {
        if (suppressSelectionOnceRef.current) {
          suppressSelectionOnceRef.current = false
          return
        }
        if (Date.now() < suppressSelectionUntilRef.current) return
        if (draggingRef.current) return
        const ed = editorRef.current!
        if (ed.hasTextFocus && !ed.hasTextFocus()) return
        const sel = ed.getSelection()
        const model = ed.getModel()
        if (!sel || sel.isEmpty() || !model) {
          onSelectionChange?.(null)
          return
        }
        const start = Math.min(sel.startLineNumber, sel.endLineNumber)
        const end = Math.max(sel.startLineNumber, sel.endLineNumber)
        const startCol = sel.startLineNumber <= sel.endLineNumber ? sel.startColumn : sel.endColumn
        const endCol = sel.startLineNumber <= sel.endLineNumber ? sel.endColumn : sel.startColumn
        const text = model.getValueInRange(sel)
        const rng = new monaco.Range(start, startCol, end, endCol)
        const anchor = computeAnchorForRange(ed, rng)
        if (anchor) onAnchorChangeRef.current?.(anchor)
        onSelRef.current?.({
          startLine: start,
          endLine: end,
          startColumn: startCol,
          endColumn: endCol,
          selectedText: text,
          anchorRect: anchor || undefined
        })
      })

      // 去掉 mousedown 命中逻辑，统一在 mouseup 里处理（避免与“空选择关闭浮层”的竞争）
    }
    return () => {
      // keep editor across renders; dispose only on unmount
    }
  }, [])

  // 滚动时更新锚点，保证浮层跟随
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const disp = ed.onDidScrollChange(() => {
      const sel = ed.getSelection()
      if (sel && !sel.isEmpty()) {
        const rng = new monaco.Range(
          Math.min(sel.startLineNumber, sel.endLineNumber),
          sel.startColumn,
          Math.max(sel.startLineNumber, sel.endLineNumber),
          sel.endColumn
        )
        const anchor = computeAnchorForRange(ed, rng)
        if (anchor) onAnchorChangeRef.current?.(anchor)
        return
      }
      const mr = lastMarkRangeRef.current
      if (mr) {
        const anchor = computeAnchorForRange(ed, mr)
        if (anchor) onAnchorChangeRef.current?.(anchor)
      }
    })
    return () => { try { disp.dispose() } catch {} }
  }, [])

  // 面板尺寸变化时触发布局，避免在可调整分割下内容不可见
  useEffect(() => {
    const el = containerRef.current
    const ed = editorRef.current
    if (!el || !ed) return
    const ro = new ResizeObserver(() => {
      try {
        ed.layout()
      } catch {}
    })
    ro.observe(el)
    // 初次也执行一次
    setTimeout(() => {
      try {
        ed.layout()
      } catch {}
    }, 0)
    return () => {
      ro.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!data || !editorRef.current) return
    // 正在拖拽选择时，延后应用初次内容，避免在拖拽过程中重置选择锚点
    if (draggingRef.current) {
      pendingInitialRef.current = data
      return
    }
    const editor = editorRef.current
    const model = editor.getModel() ?? monaco.editor.createModel('', data.language)
    if (editor.getModel() == null) editor.setModel(model)
    const st = editor.saveViewState()
    model.setValue(data.content)
    monaco.editor.setModelLanguage(model, data.language || 'plaintext')
    editor.restoreViewState(st)
    try {
      editor.layout()
    } catch {}
    endRef.current = data.endLine
    totalRef.current = data.totalLines
    // 使用返回的真实 startLine，而非请求参数，避免小文件/边界裁剪场景下的错位
    initialStartRef.current = data.startLine
    onLoadedRef.current?.(data)
  }, [data, startLine])

  // 近底自动加载下一段
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const dispose = ed.onDidScrollChange(async () => {
      // 跳转定位期间禁止自动拼接
      if (isJumpingRef.current) return
      // 定位后的短时间内抑制自动拼接，避免插段导致滚动跳动
      if (Date.now() < suppressAutoLoadUntilRef.current) return
      if (loadingMoreRef.current) return
      // 拖拽选择期间不做拼接，避免打断选择起点
      if (draggingRef.current) return
      const dom = ed.getDomNode()
      if (!dom) return
      const viewH = dom.clientHeight
      const scrollTop = ed.getScrollTop()
      const scrollH = ed.getScrollHeight()
      const nearBottom = scrollTop + viewH >= scrollH - 200
      const nearTop = scrollTop <= 80
      // 顶部向上补段（允许向上滚）
      if (nearTop && !loadingEarlierRef.current) {
        const currentStart = initialStartRef.current
        if (currentStart > 1) {
          loadingEarlierRef.current = true
          try {
            const prevStart = Math.max(1, currentStart - safeMax)
            const chunk = await fetchChunk({ path, startLine: prevStart, maxLines: safeMax })
            const model = ed.getModel()
            if (model) {
              const st = ed.saveViewState()
              const insertText = chunk.content + (model.getValueLength() > 0 ? '\n' : '')
              // 在首行首列前插入
              const range = new monaco.Range(1, 1, 1, 1)
              model.applyEdits([{ range, text: insertText, forceMoveMarkers: true }])
              ed.restoreViewState(st)
              // 更新偏移与累计信息
              initialStartRef.current = chunk.startLine
              totalRef.current = chunk.totalLines
              // 汇总回调
              const agg = {
                ...chunk,
                startLine: initialStartRef.current,
                endLine: endRef.current,
                totalLines: totalRef.current
              }
              onLoadedRef.current?.(agg as any)
            }
          } finally {
            loadingEarlierRef.current = false
          }
        }
      }
      if (!nearBottom) return
      if (endRef.current >= totalRef.current) return
      loadingMoreRef.current = true
      try {
        const nextStart = endRef.current + 1
        const chunk = await fetchChunk({ path, startLine: nextStart, maxLines: safeMax })
        const model = ed.getModel()
        if (model) {
          // 使用增量追加，尽量保持视图与选择状态
          const st = ed.saveViewState()
          const lastLine = model.getLineCount()
          const prependNl = model.getValueLength() > 0
          const insertText = (prependNl ? '\n' : '') + chunk.content
          const range = new monaco.Range(lastLine + 1, 1, lastLine + 1, 1)
          model.applyEdits([{ range, text: insertText, forceMoveMarkers: true }])
          ed.restoreViewState(st)

          endRef.current = chunk.endLine
          totalRef.current = chunk.totalLines
          // 汇总后的信息回调给上层用于显示行数
          const agg = {
            ...chunk,
            startLine: initialStartRef.current,
            endLine: endRef.current,
            totalLines: totalRef.current
          }
          onLoadedRef.current?.(agg as any)
        }
      } finally {
        loadingMoreRef.current = false
      }
    })
    return () => {
      dispose.dispose()
    }
  }, [path, maxLines])

  const lastRevealRef = useRef<{ s: number; e: number; top: number } | null>(null)
  const lastJumpKeyRef = useRef<string | null>(null)

  useImperativeHandle(fref, () => ({
    reveal: (s, e, sColOpt, eColOpt) => {
      const ed = editorRef.current
      if (!ed) return
      // 即使处于拖拽标志，也允许侧栏触发的程序化跳转；
      // 避免因上一次 mouseup 未在编辑器内触发而卡住不滚动
      draggingRef.current = false
      const model = ed.getModel()
      if (!model) return
      const offset = initialStartRef.current
      const maxLine = model.getLineCount()
      const sRelRaw = s - offset + 1
      const eRelRaw = e - offset + 1
      // 顶部预留若干行，避免被浮层遮挡
      const rawRel = Math.min(Math.max(1, sRelRaw), maxLine)
      const sRel = Math.max(1, rawRel - topPadLines)
      const eRel = Math.min(Math.max(1, eRelRaw), maxLine)
      const endCap = Math.min(maxLine, eRel)
      const sCol = sColOpt ?? 1
      const eCol = eColOpt ?? model.getLineMaxColumn(endCap)
      const selRange = new monaco.Range(Math.min(rawRel, endCap), sCol, endCap, eCol)
      const revRange = new monaco.Range(sRel, 1, sRel, 1)
      // 若与上次相同且仍在视图内，跳过滚动避免闪烁
      try {
        const key = `${s}-${e}-${sCol}-${eCol}`
        const vis = ed.getVisibleRanges() || []
        const inView = vis.some((r) => !(r.endLineNumber < selRange.startLineNumber || r.startLineNumber > selRange.endLineNumber))
        if (lastJumpKeyRef.current === key && inView) {
          ed.setSelection(selRange)
          return
        }
        lastJumpKeyRef.current = key
      } catch {}
      // 先滚后选，减少内部光标可见性逻辑对滚动的干扰
      isJumpingRef.current = true
      suppressAutoLoadUntilRef.current = Date.now() + 400
      const revealTop = () => {
        try {
          const anyEd: any = ed as any
          // 尽量使用 monaco 的 nearTop API，退化到 setScrollTop
          if (typeof anyEd.revealLineNearTop === 'function') {
            anyEd.revealLineNearTop(sRel, monaco.editor.ScrollType.Immediate)
          }
          if (typeof anyEd.revealRangeNearTop === 'function') {
            anyEd.revealRangeNearTop(revRange, monaco.editor.ScrollType.Immediate)
          }
          const top = ed.getTopForLineNumber(sRel)
          // 若当前位置已接近目标顶部，避免重复设置引发闪烁
          try {
            const curTop = ed.getScrollTop()
            if (Math.abs(curTop - top) <= 2 && lastRevealRef.current?.s === sRel && lastRevealRef.current?.e === eRel) {
              return
            }
          } catch {}
          ed.setScrollTop(top)
          lastRevealRef.current = { s: sRel, e: eRel, top }
        } catch {}
      }
      revealTop()
      // 下一帧设置选区，并抑制一次选择变更回调，避免外层误开浮层
      try { (suppressSelectionOnceRef as any).current = true } catch {}
      setTimeout(() => { try { ed.setSelection(selRange) } catch {} }, 0)
      // 40ms 后校验是否可见，若仍不可见，使用居中兜底
      setTimeout(() => {
        try {
          const vis = ed.getVisibleRanges()
          const inView = Array.isArray(vis)
            ? vis.some((r) => !(r.endLineNumber < sRel || r.startLineNumber > endCap))
            : false
          if (!inView) {
            ed.revealRangeInCenter(selRange, monaco.editor.ScrollType.Immediate)
          }
        } catch {}
        isJumpingRef.current = false
      }, 40)
    },
    revealModel: (sRelRaw, eRelRaw, sColOpt, eColOpt) => {
      const ed = editorRef.current
      if (!ed) return
      draggingRef.current = false
      const model = ed.getModel()
      if (!model) return
      const maxLine = model.getLineCount()
      const rawRel = Math.min(Math.max(1, sRelRaw), maxLine)
      const sRel = Math.max(1, rawRel - topPadLines)
      const eRel = Math.min(Math.max(1, eRelRaw), maxLine)
      const endCap = Math.min(maxLine, eRel)
      const sCol = sColOpt ?? 1
      const eCol = eColOpt ?? model.getLineMaxColumn(endCap)
      const selRange = new monaco.Range(Math.min(rawRel, endCap), sCol, endCap, eCol)
      const revRange = new monaco.Range(sRel, 1, sRel, 1)
      // 若与上次相同且仍在视图内，跳过滚动避免闪烁
      try {
        const key = `rel:${sRelRaw}-${eRelRaw}-${sCol}-${eCol}`
        const vis = ed.getVisibleRanges() || []
        const inView = vis.some((r) => !(r.endLineNumber < selRange.startLineNumber || r.startLineNumber > selRange.endLineNumber))
        if (lastJumpKeyRef.current === key && inView) {
          ed.setSelection(selRange)
          return
        }
        lastJumpKeyRef.current = key
      } catch {}
      isJumpingRef.current = true
      suppressAutoLoadUntilRef.current = Date.now() + 400
      const revealTop = () => {
        try {
          const anyEd: any = ed as any
          if (typeof anyEd.revealLineNearTop === 'function') {
            anyEd.revealLineNearTop(sRel, monaco.editor.ScrollType.Immediate)
          }
          if (typeof anyEd.revealRangeNearTop === 'function') {
            anyEd.revealRangeNearTop(revRange, monaco.editor.ScrollType.Immediate)
          }
          const top = ed.getTopForLineNumber(sRel)
          try {
            const curTop = ed.getScrollTop()
            if (Math.abs(curTop - top) <= 2 && lastRevealRef.current?.s === sRel && lastRevealRef.current?.e === eRel) {
              return
            }
          } catch {}
          ed.setScrollTop(top)
          lastRevealRef.current = { s: sRel, e: eRel, top }
        } catch {}
      }
      revealTop()
      try { (suppressSelectionOnceRef as any).current = true } catch {}
      setTimeout(() => { try { ed.setSelection(selRange) } catch {} }, 0)
      setTimeout(() => {
        try {
          const vis = ed.getVisibleRanges()
          const inView = Array.isArray(vis)
            ? vis.some((r) => !(r.endLineNumber < sRel || r.startLineNumber > endCap))
            : false
          if (!inView) {
            ed.revealRangeInCenter(selRange, monaco.editor.ScrollType.Immediate)
          }
        } catch {}
        isJumpingRef.current = false
      }, 40)
    },
    clearSelection: () => {
      const ed = editorRef.current
      if (!ed) return
      const pos = ed.getPosition() || { lineNumber: 1, column: 1 }
      const sel = new monaco.Selection(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
      ed.setSelection(sel)
    }
  }))

  // apply decorations for marks（考虑当前内容起始偏移，支持列级范围）
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    if (!decoRef.current) decoRef.current = ed.createDecorationsCollection()
    const model = ed.getModel()
    if (!model) return
    const offset = initialStartRef.current
    const maxLine = model.getLineCount()
    const visible: {
      mark: {
        id?: string
        startLine: number
        endLine: number
        startColumn?: number
        endColumn?: number
      }
      deco: monaco.editor.IModelDeltaDecoration
    }[] = []
    for (const m of marks ?? []) {
      const sRelL = m.startLine - offset + 1
      const eRelL = m.endLine - offset + 1
      if (eRelL < 1 || sRelL > maxLine) continue
      const sLine = Math.max(1, sRelL)
      const eLine = Math.min(maxLine, eRelL)
      const sCol = m.startColumn ?? 1
      const eCol = m.endColumn ?? model.getLineMaxColumn(eLine)
      visible.push({
        mark: m,
        deco: {
          range: new monaco.Range(sLine, sCol, eLine, eCol),
          options: {
            isWholeLine: false,
            inlineClassName: 'ailoom-anno-inline',
            className: '',
            linesDecorationsClassName: 'ailoom-anno-gutter',
            overviewRuler: {
              color: 'rgba(255,214,102,.6)',
              position: monaco.editor.OverviewRulerLane.Right
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }
      })
    }
    const decos = visible.map((v) => v.deco)
    const ids = decoRef.current.set(decos)
    decoMapRef.current.clear()
    ids.forEach((id, i) => {
      if (id && visible[i]) decoMapRef.current.set(id, visible[i].mark)
    })
    return () => {
      /* keep decorations */
    }
  }, [marks])

  // update wrap option when prop changes
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    ed.updateOptions({ wordWrap: wrap ? 'on' : 'off' })
  }, [wrap])

  // DOM 捕获层：在黄色内联标注上拦截鼠标按下，阻止编辑器聚焦/移动光标，仅弹出浮层
  useEffect(() => {
    const el = containerRef.current
    const ed = editorRef.current
    if (!el || !ed) return
    const onMouseDownCapture = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null
      if (!target) return
      const hitEl = target.closest('.ailoom-anno-inline') as HTMLElement | null
      if (!hitEl) return
      ev.preventDefault()
      ev.stopPropagation()
      if (!onOpenMark) return
      const anyEd: any = ed as any
      const tgt = anyEd.getTargetAtClientPoint?.(ev.clientX, ev.clientY)
      const pos = tgt?.position || ed.getPosition()
      const model = ed.getModel()
      if (pos && model) {
        const hits =
          model.getDecorationsInRange(
            new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column)
          ) || []
        for (const d of hits) {
          const m = (decoMapRef.current as any)?.get?.(d.id)
          if (m) {
            onOpenMark?.(m)
            return
          }
        }
      }
    }
    el.addEventListener('mousedown', onMouseDownCapture, true)
    return () => {
      el.removeEventListener('mousedown', onMouseDownCapture, true)
    }
  }, [onOpenMark, marks])

  if (error) {
    const msg = String((error as any)?.message || '')
    if (msg.startsWith('NON_TEXT:') || msg.startsWith('HTTP_415') || msg.includes('NON_TEXT')) {
      return (
        <div className="p-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded">
          该文件看起来不是文本（或非 UTF-8），无法预览。
        </div>
      )
    }
    return <div className="text-red-600">加载失败</div>
  }
  return (
    <div className="w-full h-full border rounded overflow-hidden">
      {isLoading && <div className="p-2 text-sm opacity-60">加载中...</div>}
      <div ref={containerRef} className="w-full h-full" />
    </div>
  )
})

export default MonacoViewer
