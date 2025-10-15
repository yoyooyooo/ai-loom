import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Annotation } from '@/lib/api/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { listAnnotations, deleteAnnotation } from '@/features/explorer/api/annotations'
import { toast } from 'sonner'
import { Pencil, Trash2, RotateCcw, ClipboardCopy, StickyNote, ListX } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'

type Props = {
  onJump?: (ann: Annotation) => void
  currentFile?: string | null
}

export default function AnnotationPanel({ onJump, currentFile }: Props) {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['annotations'],
    queryFn: listAnnotations
  })

  const storageKey = 'ailoom.annotations.expanded'
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Annotation | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  // 初始化展开状态：优先读取本地存储；若传入 currentFile 则确保该分组展开
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const setx = raw ? new Set<string>(JSON.parse(raw) as string[]) : new Set<string>()
      if (currentFile) setx.add(currentFile)
      setExpanded(setx)
    } catch {
      const setx = new Set<string>()
      if (currentFile) setx.add(currentFile)
      setExpanded(setx)
    }
  }, [currentFile])

  function saveExpanded(next: Set<string>) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(next)))
    } catch {}
  }

  async function onDelete(id: string) {
    if (!id) return
    await deleteAnnotation(id)
    await qc.invalidateQueries({ queryKey: ['annotations'] })
    await refetch()
  }

  async function onSaveEdit() {
    if (!editing) return
    const { updateAnnotation } = await import('@/features/explorer/api/annotations')
    const updated = await updateAnnotation(editing.id, { comment: editValue })
    // 本地更新，减少抖动
    qc.setQueryData(['annotations'], (prev: any) => {
      if (!Array.isArray(prev)) return prev
      const idx = prev.findIndex((a: Annotation) => a.id === editing.id)
      if (idx < 0) return prev
      const next = prev.slice()
      next[idx] = updated
      return next
    })
    setEditing(null)
    setEditValue('')
    await qc.invalidateQueries({ queryKey: ['annotations'] })
  }

  async function onClearAll() {
    try {
      const list = (data ?? []) as Annotation[]
      if (!list.length) {
        setConfirmClear(false)
        return
      }
      await Promise.allSettled(list.map((a) => deleteAnnotation(a.id)))
      await qc.invalidateQueries({ queryKey: ['annotations'] })
      await refetch()
      toast.success(`已清除 ${list.length} 条批注`)
    } catch (e: any) {
      toast.error('清除失败：' + (e?.message || ''))
    } finally {
      setConfirmClear(false)
    }
  }

  // 按文件分组与排序（确保 hooks 在所有早退 return 之前调用）
  const groups = useMemo(() => {
    const all = (data ?? []) as Annotation[]
    const grouped = new Map<string, Annotation[]>()
    for (const a of all) {
      if (!grouped.has(a.filePath)) grouped.set(a.filePath, [])
      grouped.get(a.filePath)!.push(a)
    }
    const entries = Array.from(grouped.entries())
      .map(
        ([filePath, list]) => [filePath, list.sort((x, y) => x.startLine - y.startLine)] as const
      )
      .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
    return entries
  }, [data])

  const total = useMemo(() => (data ?? []).length, [data])

  if (isLoading) return <div className="text-sm opacity-60">加载批注...</div>
  if (error) return <div className="text-red-600">加载失败</div>

  const toggleFile = (filePath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) next.delete(filePath)
      else next.add(filePath)
      saveExpanded(next)
      return next
    })
  }

  function baseName(p: string) {
    const idx = p.lastIndexOf('/')
    return idx >= 0 ? p.slice(idx + 1) : p
  }

  return (
    <div className="space-y-2 text-sm select-none">
      <div className="flex items-center justify-between px-2 py-1">
        <div className="opacity-70">批注（{total}）</div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 p-0 rounded-sm"
            title="清除所有批注"
            aria-label="清除所有批注"
            onClick={() => {
              if (!total) {
                toast.info('暂无可清除的批注')
                return
              }
              setConfirmClear(true)
            }}
          >
            <ListX className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 p-0 rounded-sm"
            title="刷新"
            aria-label="刷新"
            onClick={async () => {
              await refetch()
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 p-0 rounded-sm"
            title="生成并复制"
            aria-label="生成并复制"
            onClick={async () => {
              try {
                const r = await (
                  await import('@/features/explorer/api/stitch')
                ).stitchGenerate({ templateId: 'concise', maxChars: 6000 })
                await navigator.clipboard.writeText(r.prompt)
                toast.success('已生成并复制到剪贴板')
              } catch (e: any) {
                toast.error('生成失败：' + (e?.message || ''))
              }
            }}
          >
            <ClipboardCopy className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ul className="rounded divide-y">
        {groups.map(([filePath, anns]) => {
          const isExpanded = expanded.has(filePath)
          const isActive = currentFile && currentFile === filePath
          return (
            <li key={filePath}>
              <div
                className={`flex items-center gap-2 px-2 py-1 ${
                  isActive ? 'bg-black/5' : 'hover:bg-black/5'
                }`}
              >
                <button
                  className="flex items-center gap-1 flex-1 text-left"
                  onClick={() => toggleFile(filePath)}
                >
                  <span className="inline-block w-4 text-center">{isExpanded ? '▾' : '▸'}</span>
                  <span
                    className={`font-medium truncate flex-1 w-0 ${isActive ? 'text-blue-600' : ''}`}
                  >
                    {baseName(filePath)}
                  </span>
                  {/* <span className="ml-2 text-xs opacity-60">{filePath}</span> */}
                </button>
                <span className="text-xs opacity-60">{anns.length}</span>
              </div>
              {isExpanded && (
                <ul>
                  {anns.map((a) => (
                    <li
                      key={a.id}
                      className="pl-10 group flex items-center justify-between gap-2 px-2 py-1 hover:bg-black/5 cursor-pointer"
                      onClick={() => onJump?.(a)}
                      title={`L${a.startLine}-${a.endLine}`}
                    >
                      <div className="flex-1 overflow-hidden flex items-center gap-1.5">
                        <StickyNote className="h-4 w-4 opacity-60 shrink-0" />
                        <div className="text-sm font-medium overflow-hidden text-ellipsis whitespace-nowrap">
                          {a.comment}
                        </div>
                      </div>
                      <div className="shrink-0 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          className="h-6 w-6 grid place-items-center rounded hover:bg-black/10"
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditing(a)
                            setEditValue(a.comment || '')
                          }}
                          title="编辑"
                          aria-label="编辑"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          className="h-6 w-6 grid place-items-center rounded hover:bg-black/10 text-red-600"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDelete(a.id)
                          }}
                          title="删除"
                          aria-label="删除"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      {/* 编辑对话框（使用 AlertDialog 作为通用 Dialog） */}
      <AlertDialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null)
            setEditValue('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>编辑批注</AlertDialogTitle>
            <AlertDialogDescription>
              {editing ? `${editing.filePath} · L${editing.startLine}-${editing.endLine}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <Textarea rows={4} value={editValue} onChange={(e) => setEditValue(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setEditing(null)
                setEditValue('')
              }}
            >
              取消
            </AlertDialogCancel>
            <AlertDialogAction autoFocus onClick={onSaveEdit}>
              保存
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* 清除所有批注确认 */}
      <AlertDialog open={confirmClear} onOpenChange={(o) => setConfirmClear(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清除所有批注？</AlertDialogTitle>
            <AlertDialogDescription>
              此操作将删除当前项目内的所有批注（共 {total} 条），且不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction autoFocus onClick={onClearAll}>
              清空
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
