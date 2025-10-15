import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import * as monaco from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import '@/styles/monaco-overrides.css'
import { useQuery } from '@tanstack/react-query'
import type { FileChunk } from '@/lib/api/types'

export type ViewerHandle = {
  reveal: (startLine: number, endLine: number) => void
  clearSelection: () => void
}

type Props = {
  path: string
  startLine: number
  maxLines: number
  fetchChunk: (args: { path: string; startLine: number; maxLines: number }) => Promise<FileChunk>
  onLoaded?: (chunk: FileChunk) => void
  onSelectionChange?: (
    sel: {
      startLine: number
      endLine: number
      startColumn?: number
      endColumn?: number
      selectedText: string
    } | null
  ) => void
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
  }) => void
  wrap?: boolean
}

const MonacoViewer = forwardRef<ViewerHandle, Props>(function MonacoViewer(
  { path, startLine, maxLines, fetchChunk, onLoaded, onSelectionChange, marks, onOpenMark, wrap },
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
  const initialStartRef = useRef(startLine)
  const pendingInitialRef = useRef<FileChunk | null>(null)

  const safeStart = Number.isFinite(startLine) && startLine > 0 ? Math.floor(startLine) : 1
  const safeMax = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : 1000
  const queryKey = useMemo(() => ['file', path, safeStart, safeMax], [path, safeStart, safeMax])
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
  const onLoadedRef = useRef<typeof onLoaded | undefined>(onLoaded)

  useEffect(() => {
    onSelRef.current = onSelectionChange
  }, [onSelectionChange])
  useEffect(() => {
    onOpenMarkRef.current = onOpenMark
  }, [onOpenMark])
  useEffect(() => {
    onLoadedRef.current = onLoaded
  }, [onLoaded])
  const suppressSelectionOnceRef = useRef(false)
  const suppressSelectionUntilRef = useRef(0)
  const blockHitRef = useRef(false)

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
                onOpenMarkRef.current?.(m)
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
                onOpenMarkRef.current?.(m)
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
        onSelRef.current?.({
          startLine: start,
          endLine: end,
          startColumn: startCol,
          endColumn: endCol,
          selectedText: text
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
          initialStartRef.current = startLine
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
        onSelRef.current?.({
          startLine: start,
          endLine: end,
          startColumn: startCol,
          endColumn: endCol,
          selectedText: text
        })
      })

      // 去掉 mousedown 命中逻辑，统一在 mouseup 里处理（避免与“空选择关闭浮层”的竞争）
    }
    return () => {
      // keep editor across renders; dispose only on unmount
    }
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
    initialStartRef.current = startLine
    onLoadedRef.current?.(data)
  }, [data, startLine])

  // 近底自动加载下一段
  useEffect(() => {
    const ed = editorRef.current
    if (!ed) return
    const dispose = ed.onDidScrollChange(async () => {
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

  useImperativeHandle(fref, () => ({
    reveal: (s, e) => {
      const ed = editorRef.current
      if (!ed) return
      if (draggingRef.current) return
      const model = ed.getModel()
      if (!model) return
      const offset = initialStartRef.current
      const sRel = Math.max(1, s - offset + 1)
      const eRel = Math.max(1, e - offset + 1)
      const endCap = Math.min(model.getLineCount(), eRel)
      const range = new monaco.Range(sRel, 1, endCap, model.getLineMaxColumn(endCap))
      ed.revealRangeInCenter(range)
      ed.setSelection(range)
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
