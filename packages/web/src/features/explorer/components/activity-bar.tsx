import { FolderTree, StickyNote } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAppStore } from '@/stores/app'
import { listAnnotations } from '@/features/explorer/api/annotations'

export default function ActivityBar() {
  const { activePane, setActivePane } = useAppStore()
  const { data: anns } = useQuery({ queryKey: ['annotations'], queryFn: listAnnotations })
  const annCount = (anns ?? []).length
  return (
    <div className="w-12 shrink-0 h-full border-r flex flex-col items-center py-2 gap-2">
      <button
        title="文件"
        className={`w-9 h-9 rounded flex items-center justify-center ${activePane === 'files' ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
        onClick={() => setActivePane('files')}
      >
        <FolderTree className="w-5 h-5" />
      </button>
      <button
        title="批注"
        className={`relative w-9 h-9 rounded flex items-center justify-center ${activePane === 'annotations' ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
        onClick={() => setActivePane('annotations')}
      >
        <StickyNote className="w-5 h-5" />
        {annCount > 0 && (
          <span
            className="absolute -bottom-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[10px] leading-4 grid place-items-center"
            aria-label={`批注数量：${annCount}`}
          >
            {annCount > 99 ? '99+' : annCount}
          </span>
        )}
      </button>
    </div>
  )
}
