import { useEffect, useRef, useState } from 'react'
import { useFloating, offset, flip, shift, autoUpdate } from '@floating-ui/react'
import type { AnchorRect } from '@/components/editor/types'
import { ANCHOR_LEFT_TWEAK, FLOATING_OFFSET } from '@/components/editor/constants'
import { getBaseLeft, getUnionRectByMarkId } from '@/components/editor/utils'

export function useFloatingAnnotation(params: {
  containerEl: HTMLElement | null
  previewHostEl: HTMLElement | null
  previewScrollEl: HTMLElement | null
  mdPreview: boolean
  show: boolean
  activeMarkId: string | null
}) {
  const { containerEl, previewHostEl, previewScrollEl, mdPreview, show, activeMarkId } = params

  const [rectState, setRectState] = useState<AnchorRect | null>(null)
  const lastAnchorRectRef = useRef<AnchorRect | null>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)
  const [hasAnchor, setHasAnchor] = useState(false)
  const [coordsReady, setCoordsReady] = useState(false)
  const savedRangeRef = useRef<Range | null>(null)
  const rafRef = useRef<number | null>(null)

  const { x, y, strategy, refs, update } = useFloating({
    placement: 'top-start',
    middleware: [offset(FLOATING_OFFSET), flip({ boundary: (mdPreview ? previewScrollEl || containerEl : containerEl) || undefined }), shift({ boundary: (mdPreview ? previewScrollEl || containerEl : containerEl) || undefined, padding: 8, crossAxis: false })],
    strategy: 'fixed',
    whileElementsMounted: (reference, floating, u) => autoUpdate(reference, floating, u)
  })

  const scheduleUpdate = () => {
    try { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) } catch {}
    rafRef.current = requestAnimationFrame(() => { try { update() } catch {} })
  }

  const refreshRef = () => {
    const v = {
      getBoundingClientRect: () => {
        if (mdPreview) {
          try {
            const baseLeft = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
            if (previewHostEl && activeMarkId) {
              const uni = getUnionRectByMarkId(previewHostEl, activeMarkId, baseLeft)
              if (uni) return uni as DOMRect
            }
            if (anchorElRef.current) {
              const r = anchorElRef.current.getBoundingClientRect()
              const left = baseLeft ?? r.left
              return { x: left, y: r.top, left, top: r.top, width: Math.max(1, r.right - left), height: Math.max(1, r.height || 1), right: r.right, bottom: r.bottom } as DOMRect
            }
            // 优先使用备份的 Range
            if (savedRangeRef.current) {
              const range = savedRangeRef.current
              const list = range.getClientRects()
              const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
              const left = baseLeft ?? r.left
              return { x: left, y: r.top, left, top: r.top, width: Math.max(1, r.right - left), height: Math.max(1, r.height || 1), right: r.right, bottom: r.bottom } as DOMRect
            }
            // 其次使用当前 selection
            try {
              const sel = window.getSelection()
              if (sel && !sel.isCollapsed) {
                const range = sel.getRangeAt(0)
                const list = range.getClientRects()
                const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
                const left = baseLeft ?? r.left
                return { x: left, y: r.top, left, top: r.top, width: Math.max(1, r.right - left), height: Math.max(1, r.height || 1), right: r.right, bottom: r.bottom } as DOMRect
              }
            } catch {}
          } catch {}
          const r = lastAnchorRectRef.current!
          const baseLeft = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
          if (r && baseLeft != null) {
            const left = baseLeft
            return { x: left, y: r.y, left, top: r.y, width: Math.max(1, r.width || 1), height: Math.max(1, r.height || 1), right: left + Math.max(1, r.width || 1), bottom: r.y + Math.max(1, r.height || 1) } as DOMRect
          }
          return (r || { x: 0, y: 0, left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }) as DOMRect
        }
        const r = lastAnchorRectRef.current!
        return (r || { x: 0, y: 0, left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }) as DOMRect
      },
      contextElement: (mdPreview ? (previewScrollEl || containerEl) : containerEl) || undefined
    }
    ;(refs.setReference as any)(v)
    scheduleUpdate()
  }

  useEffect(() => {
    if (!show) return
    // 非预览（Monaco）：只有在拿到首个 anchorRect 后再设置 reference，避免落到 (0,0)
    if (!mdPreview && !lastAnchorRectRef.current) return
    // 预览模式（Markdown）：需等待命中元素或首个 anchorRect 就绪，避免首帧错误定位
    if (mdPreview && !anchorElRef.current && !lastAnchorRectRef.current) return
    setHasAnchor(true)
    refreshRef()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mdPreview, show, containerEl, previewHostEl, previewScrollEl, activeMarkId])

  // 依据 x/y 是否就绪控制首帧显隐
  useEffect(() => {
    if (!show || !hasAnchor) {
      setCoordsReady(false)
      return
    }
    const ok = x != null && y != null
    setCoordsReady(!!ok)
  }, [x, y, show, hasAnchor])

  // 关闭时重置 anchor/coods 状态
  useEffect(() => {
    if (!show) {
      setHasAnchor(false)
      setCoordsReady(false)
    }
  }, [show])

  useEffect(() => {
    if (!mdPreview || !show) return
    const sc = previewScrollEl
    if (!sc) return
    const onScroll = () => { scheduleUpdate() }
    sc.addEventListener('scroll', onScroll, { passive: true })
    const onWinScroll = () => { scheduleUpdate() }
    window.addEventListener('scroll', onWinScroll, true)
    return () => {
      sc.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onWinScroll, true)
    }
  }, [mdPreview, show, previewScrollEl, update])

  useEffect(() => {
    if (!mdPreview || !show) return
    const host = previewHostEl
    if (!host) return
    const ro = new ResizeObserver(() => { scheduleUpdate() })
    try { ro.observe(host) } catch {}
    return () => { try { ro.disconnect() } catch {} }
  }, [mdPreview, show, previewHostEl, update])

  return {
    x,
    y,
    strategy,
    refs,
    update,
    hasAnchor,
    coordsReady,
    rect: rectState,
    setAnchorRect: (rect: AnchorRect | null | undefined) => {
      if (!rect) return
      lastAnchorRectRef.current = rect
      setHasAnchor(true)
      setRectState(rect)
      refreshRef()
    },
    setAnchorEl: (el: HTMLElement | null) => {
      anchorElRef.current = el
      if (el) setHasAnchor(true)
      refreshRef()
    },
    setAnchorRange: (range: Range | null) => {
      savedRangeRef.current = range
      if (range) setHasAnchor(true)
      refreshRef()
    }
  }
}
