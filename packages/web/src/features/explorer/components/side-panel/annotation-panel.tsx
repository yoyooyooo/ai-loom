import AnnotationPanel from '@/features/explorer/components/annotation-panel'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import type { Annotation } from '@/lib/api/types'

export default function SideAnnotationPanel() {
  const { selectedPath, setSelectedPath, pageSize } = useAppStore()
  const { setStartLine, setPendingJump } = useExplorerStore()
  const onJump = (ann: Annotation) => {
    if (selectedPath !== ann.filePath) {
      setSelectedPath(ann.filePath)
    }
    const safePage = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000
    setStartLine(Math.max(1, ann.startLine - Math.floor(safePage / 2)))
    setPendingJump({ startLine: ann.startLine, endLine: ann.endLine, id: ann.id, comment: ann.comment })
  }
  return <AnnotationPanel onJump={onJump} />
}
