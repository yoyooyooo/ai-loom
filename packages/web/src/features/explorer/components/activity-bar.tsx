import { FolderTree, StickyNote } from 'lucide-react'
import { useAppStore } from '@/stores/app'

export default function ActivityBar() {
  const { activePane, setActivePane } = useAppStore()
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
        className={`w-9 h-9 rounded flex items-center justify-center ${activePane === 'annotations' ? 'bg-black/10 dark:bg-white/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}
        onClick={() => setActivePane('annotations')}
      >
        <StickyNote className="w-5 h-5" />
      </button>
    </div>
  )
}
