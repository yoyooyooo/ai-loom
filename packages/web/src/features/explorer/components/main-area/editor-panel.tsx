import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import MonacoEditorFull, { EditorFullHandle } from '@/components/editor/MonacoEditorFull'
import type { DirEntry } from '@/lib/api/types'
import { fetchFileFull, saveFile } from '@/features/explorer/api/files'
import { ws } from '@/lib/ws/singleton'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import { toast } from 'sonner'
import EditorPanelMonaco from '@/features/explorer/components/main-area/editor-panel-monaco'
import EditorPanelMarkdown from '@/features/explorer/components/main-area/editor-panel-markdown'

export default function EditorPanel() {
  const qc = useQueryClient()
  const { selectedPath, wrap, toggleWrap, mdPreview, toggleMdPreview, currentDir, currentRoot } = useAppStore()
  const { full, enterFull, exitFull, setSelection, chunkInfo } = useExplorerStore()
  const editorRef = useRef<EditorFullHandle | null>(null)

  // 切换文件时重置选区（对齐旧行为）
  useEffect(() => { setSelection(null) }, [selectedPath, setSelection])

  // 外部文件变更提醒/刷新（监听 file.changed 针对当前选中文件）
  useEffect(() => {
    if (!selectedPath) return
    const sub = ws.notification$('file.changed').subscribe(async (p: any) => {
      try {
        const path = String(p?.path || '')
        if (!path || path !== selectedPath) return
        // 仅在全量编辑模式下提示/刷新；只读分页模式已由 Query 失效自动刷新
        if (full) {
          const currentVal = editorRef.current?.getValue?.() || full.content
          // 若未修改（编辑器内容与已知内容一致），则自动刷新到最新
          if (currentVal === full.content) {
            try {
              const f = await fetchFileFull(selectedPath)
              enterFull({ ...full, content: f.content, digest: f.digest, language: f.language })
              toast.success('已刷新最新内容')
            } catch {}
            return
          }
          // 若有本地修改，提示用户手动刷新，避免覆盖未保存内容
          toast.info('文件已被外部修改', {
            action: {
              label: '刷新',
              onClick: async () => {
                try {
                  const f = await fetchFileFull(selectedPath)
                  enterFull({ ...full, content: f.content, digest: f.digest, language: f.language })
                } catch (err: any) {
                  toast.error('刷新失败：' + String(err?.message || err))
                }
              }
            }
          } as any)
        }
      } catch {}
    })
    return () => { try { sub.unsubscribe() } catch {} }
  }, [selectedPath, full, enterFull])

  // 目录树缓存（用于显示当前文件大小）
  const treeCached = qc.getQueryData(['tree', currentRoot, currentDir]) as DirEntry[] | undefined

  return (
    <div className="flex-1 h-full flex flex-col overflow-hidden">
      {!selectedPath && <div className="text-sm opacity-70">选择左侧的文件以查看内容</div>}
      {selectedPath && (
        <>
          <div className="shrink-0 flex items-center justify-between text-sm px-2 py-1">
            <div>
              <span className="opacity-70 mr-2">文件:</span>
              <code className="px-1.5 py-0.5 bg-black/5 dark:bg-white/5 rounded">{selectedPath}</code>
              {chunkInfo && (
                <span className="ml-2 opacity-60">L{chunkInfo.start}-{chunkInfo.end}/{chunkInfo.total}</span>
              )}
              {(() => {
                const size = treeCached?.find((e) => e.path === selectedPath)?.size
                if (size == null) return null
                const human = size < 1024 ? size + 'B' : size < 1024 * 1024 ? (size / 1024).toFixed(1) + 'KB' : (size / 1024 / 1024).toFixed(1) + 'MB'
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
                      if (msg.startsWith('OVER_LIMIT') || msg.includes('MESSAGE_TOO_LARGE') || msg.startsWith('HTTP_413')) toast.error('文件过大，无法全量读取')
                      else if (msg.includes('NON_TEXT') || msg.startsWith('HTTP_415')) toast.error('该文件不是可预览的文本')
                      else toast.error('进入编辑失败：' + msg)
                    }
                  }}
                >
                  进入编辑
                </button>
              )}
            </div>
          </div>

          <div className="relative flex-1 min-h-0">
            {!full ? (
              mdPreview ? <EditorPanelMarkdown /> : <EditorPanelMonaco />
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    className="px-2 py-1 text-sm border rounded"
                    onClick={async () => {
                      if (!selectedPath || !full) return
                      const content = editorRef.current?.getValue() || full.content
                      try {
                        const r = await saveFile({ path: selectedPath, content, baseDigest: full.digest })
                        if (r.ok) enterFull({ ...full, content, digest: r.digest || full.digest })
                      } catch (err: any) {
                        const msg = String(err?.message || '')
                        if (msg.startsWith('CONFLICT:')) toast.error('保存冲突：文件已被外部修改，请刷新内容后再试')
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
                      const r = await saveFile({ path: selectedPath, content, baseDigest: full.digest })
                      if (r.ok) enterFull({ ...full, content, digest: r.digest || full.digest })
                    } catch (err: any) {
                      const msg = String(err?.message || '')
                      if (msg.startsWith('CONFLICT:')) toast.error('保存冲突：文件已被外部修改，请刷新内容后再试')
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
