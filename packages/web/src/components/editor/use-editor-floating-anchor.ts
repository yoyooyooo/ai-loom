import { useEffect, useRef, useState } from 'react'
import type { AnchorRect } from '@/components/editor/types'

export function useEditorFloatingAnchor(params: { show: boolean }) {
  const { show } = params
  const [rectState, setRectState] = useState<AnchorRect | null>(null)
  const lastAnchorRectRef = useRef<AnchorRect | null>(null)
  const [hasAnchor, setHasAnchor] = useState(false)

  useEffect(() => {
    if (!show) {
      setHasAnchor(false)
    }
  }, [show])

  return {
    // 占位：Editor 模式不用 x/y/strategy/refs/update
    x: 0,
    y: 0,
    strategy: 'fixed' as const,
    refs: { setFloating: (_node: any) => {} },
    update: () => {},
    hasAnchor,
    coordsReady: !!rectState,
    rect: rectState,
    setAnchorRect: (rect: AnchorRect | null | undefined) => {
      if (!rect) return
      lastAnchorRectRef.current = rect
      setRectState(rect)
      setHasAnchor(true)
    },
    setAnchorEl: (_el: HTMLElement | null) => {},
    setAnchorRange: (_range: Range | null) => {}
  }
}
