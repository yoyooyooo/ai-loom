import { useQuery, useQueryClient } from '@tanstack/react-query'
import { listAnnotations, deleteAnnotation } from '@/features/explorer/api/annotations'
import type { Annotation } from '@/lib/api/types'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

type Props = {
  onJump?: (ann: Annotation) => void
  currentFile?: string | null
}

export default function AnnotationPanel({ onJump, currentFile }: Props) {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })
  async function onDelete(id: string) {
    if (!id) return
    await deleteAnnotation(id)
    await qc.invalidateQueries({ queryKey: ['annotations'] })
    await refetch()
  }

  if (isLoading) return <div className="text-sm opacity-60">加载批注...</div>
  if (error) return <div className="text-red-600">加载失败</div>

  const items = (data ?? []).filter(a => !currentFile || a.filePath === currentFile)

  return (
    <div className="space-y-2">
      <div className="text-sm opacity-70">批注（{items.length}）</div>
      <ul className="divide-y border rounded">
        {items.map(a => (
          <li key={a.id} className="p-2 hover:bg-black/5 flex items-start justify-between gap-2">
            <div>
              <div className="text-xs opacity-70">{a.filePath} · L{a.startLine}-{a.endLine}</div>
              <div className="text-sm font-medium line-clamp-2">{a.comment}</div>
            </div>
            <div className="shrink-0 flex items-center gap-2">
              <button className="px-2 py-1 text-xs border rounded" onClick={() => onJump?.(a)}>回跳</button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button className="px-2 py-1 text-xs border rounded text-red-600">删除</button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>确认删除该批注？</AlertDialogTitle>
                    <AlertDialogDescription>
                      {a.filePath} · L{a.startLine}-{a.endLine}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>取消</AlertDialogCancel>
                    <AlertDialogAction autoFocus onClick={() => onDelete(a.id)}>删除</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </li>
        ))}
      </ul>
      <div className="text-right">
        <button className="px-2 py-1 text-xs border rounded" onClick={()=>refetch()}>刷新</button>
      </div>
    </div>
  )
}
