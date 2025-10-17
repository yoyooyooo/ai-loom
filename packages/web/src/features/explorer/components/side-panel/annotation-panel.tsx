import AnnotationPanel from '@/features/explorer/components/annotation-panel'
import { useAppStore } from '@/stores/app'
import { useExplorerStore } from '@/stores/explorer'
import type { Annotation } from '@/lib/api/types'

export default function SideAnnotationPanel() {
  const { selectedPath, setSelectedPath, pageSize } = useAppStore()
  const {
    startLine,
    setStartLine,
    setPendingJump,
    bumpReveal,
    chunkInfo,
    activeAnnId,
    selection,
    showToolbar,
    openToolbar,
    setActiveAnnId,
    setComment,
    setSelection
  } = useExplorerStore()
  const onJump = (ann: Annotation) => {
    const sameFile = selectedPath === ann.filePath
    if (!sameFile) setSelectedPath(ann.filePath)
    // 若当前已是该批注且选区一致：避免重复滚动，只确保浮层开启
    const sameAnnSelected =
      sameFile &&
      activeAnnId === ann.id &&
      selection &&
      selection.startLine === ann.startLine &&
      selection.endLine === ann.endLine
    if (sameAnnSelected) {
      // 已在同一标注位置：不重复滚动、不打开浮层
      return
    }

    const inCurrentChunk =
      sameFile && chunkInfo && ann.startLine >= chunkInfo.start && ann.endLine <= chunkInfo.end

    if (inCurrentChunk) {
      // 同分片：直接交给 EditorPanel 的 effect 即时 reveal，避免重载引发闪烁
      setPendingJump({
        startLine: ann.startLine,
        endLine: ann.endLine,
        startColumn: ann.startColumn,
        endColumn: ann.endColumn,
        id: ann.id,
        comment: ann.comment
      })
      return
    }

    // 其他情况：调整分页起点并强制刷新，onLoaded 中统一 reveal
    const safePage = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000
    const targetStart = Math.max(1, ann.startLine - Math.floor(safePage / 2))
    setStartLine(targetStart)
    setPendingJump({
      startLine: ann.startLine,
      endLine: ann.endLine,
      startColumn: ann.startColumn,
      endColumn: ann.endColumn,
      id: ann.id,
      comment: ann.comment
    })
    // 若分页起点未变化，则主动 bump 触发 refetch；否则等待分页参数变更驱动加载
    if (sameFile && targetStart === startLine) bumpReveal()
  }
  return <AnnotationPanel onJump={onJump} currentFile={selectedPath} />
}
