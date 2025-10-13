import FileTree from '@/features/explorer/components/file-tree'
import { useAppStore } from '@/stores/app'

export default function FileTreePanel() {
  const { currentDir, selectedPath, setSelectedPath } = useAppStore()
  return (
    <FileTree root={currentDir} selectedPath={selectedPath} onOpenFile={(p)=> setSelectedPath(p)} />
  )
}

