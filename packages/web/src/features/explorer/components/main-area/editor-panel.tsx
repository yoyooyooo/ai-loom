import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Textarea } from '@/components/ui/textarea'
import MonacoViewer, { ViewerHandle } from '@/components/editor/MonacoViewer'
import MarkdownPreview, { PreviewHandle } from '@/components/editor/MarkdownPreview'
import MonacoEditorFull, { EditorFullHandle } from '@/components/editor/MonacoEditorFull'
import type { DirEntry } from '@/lib/api/types'
import { createAnnotation, updateAnnotation, deleteAnnotation, exportAnnotations, importAnnotations, listAnnotations } from '@/features/explorer/api/annotations'
import { fetchFileFull, saveFile, fetchFileChunk } from '@/features/explorer/api/files'
import { stitchGenerate } from '@/features/explorer/api/stitch'
import type { Annotation, FileChunk } from '@/lib/api/types'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'

export default function EditorPanel() {
  const qc = useQueryClient()
  const { data: anns } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })

  const { selectedPath, pageSize, wrap, toggleWrap, mdPreview, toggleMdPreview, currentDir } = useAppStore()
  const {
    startLine, setStartLine,
    selection, setSelection,
    showToolbar, openToolbar, closeToolbar,
    comment, setComment,
    activeAnnId, setActiveAnnId,
    full, enterFull, exitFull,
    chunkInfo, setChunkInfo,
    consumePendingJump,
  } = useExplorerStore()

  const viewerRef = useRef<ViewerHandle | null>(null)
  const previewRef = useRef<PreviewHandle | null>(null)
  const editorRef = useRef<EditorFullHandle | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const [mdContent, setMdContent] = useState<string | null>(null)
  const lastEditedRef = useRef<Map<string, Annotation>>(new Map())

  // 预览内容加载
  useEffect(() => {
    const run = async () => {
      if (!mdPreview) { setMdContent(null); return }
      if (!selectedPath || !selectedPath.toLowerCase().endsWith('.md')) { setMdContent(null); return }
      try {
        const f = await fetchFileFull(selectedPath)
        setMdContent(f.content)
      } catch { setMdContent(null) }
    }
    run()
  }, [mdPreview, selectedPath])

  // 选中文件变化时复位页面态
  useEffect(() => { setStartLine(1) }, [selectedPath])
  useEffect(() => { closeToolbar(); setComment(''); setSelection(null) }, [selectedPath])

  // 浮层聚焦
  useEffect(() => {
    if (showToolbar) setTimeout(() => inputRef.current?.focus(), 0)
  }, [showToolbar])

  const onLoaded = (chunk: FileChunk) => {
    setChunkInfo({ start: chunk.startLine, end: chunk.endLine, total: chunk.totalLines })
    const pj = consumePendingJump()
    if (pj && selectedPath) {
      if (mdPreview) previewRef.current?.reveal?.(pj.startLine, pj.endLine)
      else viewerRef.current?.reveal?.(pj.startLine, pj.endLine)
      setSelection({ startLine: pj.startLine, endLine: pj.endLine, selectedText: '', startColumn: undefined, endColumn: undefined })
      if (pj.id) setActiveAnnId(pj.id)
      if (pj.comment) setComment(pj.comment)
      openToolbar()
    }
  }

  const onSelectionChange = (s: typeof selection) => {
    if (showToolbar) return
    if (activeAnnId) return
    if (toolbarRef.current && document.activeElement && toolbarRef.current.contains(document.activeElement)) return
    if (s) {
      const prev = selection
      const changed = !prev || prev.startLine !== s.startLine || prev.endLine !== s.endLine || prev.startColumn !== s.startColumn || prev.endColumn !== s.endColumn
      if (changed) {
        setSelection(s)
        openToolbar()
        if (activeAnnId) setActiveAnnId(null)
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
      closeToolbar(); viewerRef.current?.clearSelection?.()
    }
    document.addEventListener('mousedown', onDocMouseDown, false)
    return () => document.removeEventListener('mousedown', onDocMouseDown, false)
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
      priority: 'P1',
    })
    lastEditedRef.current.set(created.id, created)
    qc.setQueryData(['annotations'], (prev: any) => {
      if (!Array.isArray(prev)) return [created]
      const exists = prev.findIndex((a: any) => a.id === created.id)
      if (exists >= 0) { const next = prev.slice(); next[exists] = created; return next }
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
      comment: comment.trim(),
    })
    lastEditedRef.current.set(updated.id, updated)
    qc.setQueryData(['annotations'], (prev: any) => {
      if (!Array.isArray(prev)) return prev
      return prev.map((a: any) => a.id === updated.id ? updated : a)
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
    <div className="flex-1 h-full flex flex-col overflow-hidden p-3">
      <div className="shrink-0 flex items-center justify-between mb-2">
        <div className="text-sm opacity-70">批注操作</div>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 text-xs border rounded" onClick={async ()=>{
            const bundle = await exportAnnotations()
            const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = 'ailoom-annotations.json'
            a.click()
            URL.revokeObjectURL(url)
          }}>导出</button>
          <button className="px-2 py-1 text-xs border rounded" onClick={async ()=>{
            try {
              const r = await stitchGenerate({ templateId: 'concise', maxChars: 6000 })
              await navigator.clipboard.writeText(r.prompt)
              alert('已生成并复制到剪贴板')
            } catch (e:any) {
              alert('生成失败：' + (e?.message||''))
            }
          }}>生成并复制</button>
          <label className="px-2 py-1 text-xs border rounded cursor-pointer">
            导入
            <input type="file" className="hidden" accept="application/json" onChange={async (e)=>{
              const file = e.target.files?.[0]
              if (!file) return
              const text = await file.text()
              try {
                const payload = JSON.parse(text)
                await importAnnotations(payload)
                await qc.invalidateQueries({ queryKey: ['annotations'] })
                alert('导入完成')
              } catch(err) {
                alert('导入失败: ' + (err as Error).message)
              } finally {
                e.currentTarget.value = ''
              }
            }} />
          </label>
        </div>
      </div>
      {!selectedPath && <div className="text-sm opacity-70">选择左侧的文件以查看内容</div>}
      {selectedPath && (
        <>
          <div className="shrink-0 flex items-center justify-between text-sm">
            <div>
              <span className="opacity-70 mr-2">文件:</span>
              <code className="px-1.5 py-0.5 bg-black/5 rounded">{selectedPath}</code>
              {chunkInfo && (
                <span className="ml-2 opacity-60">L{chunkInfo.start}-{chunkInfo.end}/{chunkInfo.total}</span>
              )}
              {(() => {
                const size = treeCached?.find((e)=>e.path===selectedPath)?.size
                if (size == null) return null
                const human = size < 1024 ? size+ 'B' : size < 1024*1024 ? (size/1024).toFixed(1)+'KB' : (size/1024/1024).toFixed(1)+'MB'
                return <span className="ml-2 opacity-60">{human}</span>
              })()}
            </div>
            <div className="flex items-center gap-2">
              {!full && (
                <button className="px-2 py-1 border rounded" onClick={toggleWrap}>{wrap ? '关闭换行' : '自动换行'}</button>
              )}
              {selectedPath?.toLowerCase().endsWith('.md') && !full && (
                <button className="px-2 py-1 border rounded" onClick={toggleMdPreview}>{mdPreview ? '关闭预览' : '预览'}</button>
              )}
              {(treeCached?.find((e)=>e.path===selectedPath)?.size ?? 0) <= 512000 && (
                <button className="px-2 py-1 border rounded" onClick={async()=>{
                  const f = await fetchFileFull(selectedPath)
                  enterFull({ content: f.content, language: f.language, digest: f.digest })
                  setSelection(null); 
                }}>进入编辑</button>
              )}
            </div>
          </div>
          <div className="relative flex-1 min-h-0">
            {!full && showToolbar && (
              <div
                ref={toolbarRef}
                className="absolute top-2 left-2 z-20 w-[320px] bg-white/90 dark:bg-black/60 backdrop-blur px-2 py-2 rounded border border-black/10 dark:border-white/10 shadow"
              >
                <div className="text-xs opacity-70 mb-1">{activeAnnId ? '编辑批注' : '新建批注'}</div>
                <Textarea ref={inputRef} value={comment} onChange={(e)=>setComment(e.target.value)} rows={3} className="mb-2" />
                <div className="flex items-center gap-2">
                  {activeAnnId ? (
                    <>
                      <button className="px-2 py-1 text-sm border rounded" onClick={doUpdate}>更新</button>
                      <button className="px-2 py-1 text-sm border rounded" onClick={doDelete}>删除</button>
                    </>
                  ) : (
                    <button className="px-2 py-1 text-sm border rounded" onClick={doCreate}>新建</button>
                  )}
                  <button className="px-2 py-1 text-sm border rounded" onClick={()=>{ closeToolbar(); setSelection(null); setActiveAnnId(null); viewerRef.current?.clearSelection?.() }}>取消</button>
                </div>
              </div>
            )}

            {!full ? (
              <>
                {mdPreview && selectedPath?.toLowerCase().endsWith('.md') ? (
                  mdContent ? (
                    <MarkdownPreview
                      ref={previewRef}
                      content={mdContent}
                      annotations={(anns ?? []).filter(a=>a.filePath===selectedPath).map(a=>({ id: a.id, startLine: a.startLine, endLine: a.endLine, startColumn: a.startColumn, endColumn: a.endColumn }))}
                      onSelectionChange={(s)=>{
                        if (showToolbar) return
                        if (!s) { onSelectionChange(null); return }
                        setSelection(s); openToolbar(); setActiveAnnId(null); setComment('')
                      }}
                      onOpenMark={(m)=>{
                        setSelection({ startLine: m.startLine, endLine: m.endLine, startColumn: m.startColumn, endColumn: m.endColumn, selectedText: '' })
                        const id = m.id || null
                        setActiveAnnId(id)
                        let ann = (id && lastEditedRef.current.get(id)) || (anns ?? []).find(a=>a.id===id)
                        setComment(ann?.comment || '')
                        openToolbar()
                      }}
                    />
                  ) : (
                    <div className="p-2 text-sm opacity-60">预览加载中...</div>
                  )
                ) : (
                  <MonacoViewer
                    ref={viewerRef}
                    path={selectedPath}
                    startLine={startLine}
                    maxLines={pageSize}
                    fetchChunk={fetchFileChunk}
                    onLoaded={onLoaded}
                    onSelectionChange={onSelectionChange}
                    marks={(anns ?? []).filter(a=>a.filePath===selectedPath).map(a=>({ id: a.id, startLine: a.startLine, endLine: a.endLine, startColumn: a.startColumn, endColumn: a.endColumn }))}
                    onOpenMark={(m)=>{
                      setSelection({ startLine: m.startLine, endLine: m.endLine, startColumn: m.startColumn, endColumn: m.endColumn, selectedText: '' })
                      const id = m.id || null
                      setActiveAnnId(id)
                      let ann = (id && lastEditedRef.current.get(id)) || (anns ?? []).find(a=>a.id===id)
                      setComment(ann?.comment || '')
                      openToolbar()
                    }}
                    wrap={wrap}
                  />
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <button className="px-2 py-1 text-sm border rounded" onClick={async()=>{
                    if (!selectedPath || !full) return
                    const content = editorRef.current?.getValue() || full.content
                    try {
                      const r = await saveFile({ path: selectedPath, content, baseDigest: full.digest })
                      if (r.ok) { enterFull({ ...full, content, digest: r.digest || full.digest }) }
                    } catch (err: any) {
                      const msg = String(err?.message||'')
                      if (msg.startsWith('CONFLICT:')) alert('保存冲突：文件已被外部修改，请刷新内容后再试')
                      else alert('保存失败：' + msg)
                    }
                  }}>保存(Ctrl/⌘S)</button>
                  <button className="px-2 py-1 text-sm border rounded" onClick={()=>exitFull()}>退出编辑</button>
                </div>
                <MonacoEditorFull
                  ref={editorRef}
                  content={full.content}
                  language={full.language}
                  editable
                  onSave={async (content)=>{
                    if (!selectedPath || !full) return
                    try {
                      const r = await saveFile({ path: selectedPath, content, baseDigest: full.digest })
                      if (r.ok) { enterFull({ ...full, content, digest: r.digest || full.digest }) }
                    } catch (err: any) {
                      const msg = String(err?.message||'')
                      if (msg.startsWith('CONFLICT:')) alert('保存冲突：文件已被外部修改，请刷新内容后再试')
                      else alert('保存失败：' + msg)
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
