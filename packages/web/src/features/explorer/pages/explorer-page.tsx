import { useQuery, useIsFetching } from '@tanstack/react-query'
import { fetchTree } from '@/features/explorer/api/tree'
import { useAppStore } from '@/stores/app'
import ActivityBar from '@/features/explorer/components/activity-bar'
import FileTreePanel from '@/features/explorer/components/side-panel/file-tree-panel'
import SideAnnotationPanel from '@/features/explorer/components/side-panel/annotation-panel'
import EditorPanel from '@/features/explorer/components/main-area/editor-panel'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'

export default function ExplorerPage() {
  const { currentDir, activePane } = useAppStore()

  // 预热目录树缓存
  useQuery({ queryKey: ['tree', currentDir], queryFn: () => fetchTree(currentDir) })

  // 各面板独立 loading：
  // - 文件树：当前 root 相关的 tree 查询
  // - 批注：annotations 查询
  const fetchingTree =
    useIsFetching({
      predicate: (q) =>
        Array.isArray(q.queryKey) && q.queryKey[0] === 'tree' && q.queryKey[1] === currentDir
    }) > 0
  const fetchingAnns =
    useIsFetching({
      predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'annotations'
    }) > 0

  return (
    <div className="h-full overflow-hidden flex">
      <ActivityBar />
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-w-0">
        <ResizablePanel defaultSize={28} minSize={18} maxSize={60} className="min-w-[220px]">
          <div className="h-full overflow-hidden relative">
            {(activePane === 'files' ? fetchingTree : activePane === 'annotations' ? fetchingAnns : false) && (
              <div className="absolute top-0 left-0 right-0 h-[3px] overflow-hidden pointer-events-none">
                <div className="absolute inset-0 bg-black/5 dark:bg-white/10" />
                <div
                  className="absolute top-0 left-0 h-full text-primary dark:text-white"
                  style={{
                    width: '22%',
                    background: 'currentColor',
                    clipPath: 'polygon(0% 50%, 6% 0%, 94% 0%, 100% 50%, 94% 100%, 6% 100%)',
                    animation:
                      'ailoom-indeterminate 1.6s cubic-bezier(0.2, 0.0, 0.8, 1.0) infinite',
                    willChange: 'transform'
                  }}
                />
              </div>
            )}
            <div className="h-full overflow-auto">
              {activePane === 'files' ? (
                <FileTreePanel />
              ) : activePane === 'annotations' ? (
                <SideAnnotationPanel />
              ) : null}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel className="min-w-0">
          <EditorPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
