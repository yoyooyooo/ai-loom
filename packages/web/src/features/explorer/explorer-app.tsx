import { useIsFetching, useQuery } from '@tanstack/react-query'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { fetchTree } from '@/features/explorer/api/tree'
import { useAppStore } from '@/stores/app'
import { useExplorerInvalidations } from '@/features/explorer/invalidations'
import FileTreePanel from '@/features/explorer/components/side-panel/file-tree-panel'
import SideAnnotationPanel from '@/features/explorer/components/side-panel/annotation-panel'
import EditorPanel from '@/features/explorer/components/main-area/editor-panel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMemo } from 'react'
import { cn } from '@/lib/utils'

export function ExplorerApp() {
  const { currentRoot, currentDir, explorerSidebarTab, setExplorerSidebarTab } = useAppStore()

  useExplorerInvalidations()
  useQuery({ queryKey: ['tree', currentRoot, currentDir], queryFn: () => fetchTree(currentDir) })

  const loadingState = useExplorerLoadingState({
    currentRoot,
    currentDir,
    activeTab: explorerSidebarTab
  })

  return (
    <div className="flex h-full min-h-0">
      <ResizablePanelGroup direction="horizontal" className="flex-1 min-w-0">
        <ResizablePanel defaultSize={28} minSize={18} maxSize={60} className="min-w-[240px]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="relative">
              <Tabs
                value={explorerSidebarTab}
                onValueChange={(val) => setExplorerSidebarTab(val as 'files' | 'annotations')}
                className="border-b border-border/60 px-3 py-2"
              >
                <TabsList className="grid grid-cols-2 bg-transparent">
                  <TabsTrigger
                    value="files"
                    className={cn(
                      'text-xs',
                      explorerSidebarTab === 'files' ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    文件
                  </TabsTrigger>
                  <TabsTrigger
                    value="annotations"
                    className={cn(
                      'text-xs',
                      explorerSidebarTab === 'annotations'
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    )}
                  >
                    批注
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {loadingState ? (
                <SidebarProgress className="absolute left-0 right-0 bottom-0" />
              ) : null}
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
              {explorerSidebarTab === 'files' ? <FileTreePanel /> : <SideAnnotationPanel />}
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

function useExplorerLoadingState({
  currentRoot,
  currentDir,
  activeTab
}: {
  currentRoot: string
  currentDir: string
  activeTab: 'files' | 'annotations'
}) {
  const fetchingTree =
    useIsFetching({
      predicate: (q) =>
        Array.isArray(q.queryKey) &&
        q.queryKey[0] === 'tree' &&
        q.queryKey[1] === currentRoot &&
        q.queryKey[2] === currentDir
    }) > 0
  const fetchingAnns =
    useIsFetching({
      predicate: (q) => Array.isArray(q.queryKey) && q.queryKey[0] === 'annotations'
    }) > 0
  return activeTab === 'files' ? fetchingTree : fetchingAnns
}

function SidebarProgress({ className }: { className?: string }) {
  return (
    <div className={cn('pointer-events-none h-[3px] overflow-hidden', className)}>
      <div className="absolute inset-0 bg-black/5 dark:bg-white/10" />
      <div
        className="absolute top-0 left-0 h-full text-primary dark:text-white"
        style={{
          width: '22%',
          background: 'currentColor',
          clipPath: 'polygon(0% 50%, 6% 0%, 94% 0%, 100% 50%, 94% 100%, 6% 100%)',
          animation: 'ailoom-indeterminate 1.6s cubic-bezier(0.2, 0.0, 0.8, 1.0) infinite',
          willChange: 'transform'
        }}
      />
    </div>
  )
}
