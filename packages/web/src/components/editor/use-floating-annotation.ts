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
  const floatingElRef = useRef<HTMLElement | null>(null)
  const [placement, setPlacement] = useState<'top-start' | 'bottom-start'>('top-start')
  // Markdown 模式翻转的滞后阈值（避免在边界附近轻微滚动时来回翻转）
  const HYSTERESIS_PX = 12
  const savedRangeRef = useRef<Range | null>(null)
  const rafRef = useRef<number | null>(null)

  const { x, y, strategy, refs, update } = useFloating({
    placement,
    // Editor 模式使用 flip/shift；Markdown 模式改为手动阈值翻转，禁用自动 flip/shift
    middleware: mdPreview
      ? [offset(FLOATING_OFFSET)]
      : [
          offset(FLOATING_OFFSET),
          flip({ boundary: (containerEl as any) || undefined }),
          shift({ boundary: (containerEl as any) || undefined, padding: 8, crossAxis: false })
        ],
    strategy: 'fixed',
    whileElementsMounted: (reference, floating, u) => autoUpdate(reference, floating, u)
  })

  const scheduleUpdate = () => {
    try { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) } catch {}
    rafRef.current = requestAnimationFrame(() => {
      try {
        if (mdPreview) {
          // 在每次更新前尝试依据阈值重新判定上下放置方向
          const contRect =
            (previewScrollEl || containerEl)?.getBoundingClientRect() ||
            ({ top: 0, bottom: window.innerHeight } as any)
          const r = (() => {
            try {
              // 复用 refreshRef 的计算逻辑
              const baseLeft = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
              if (previewHostEl && activeMarkId) {
                const uni = getUnionRectByMarkId(previewHostEl, activeMarkId, baseLeft)
                if (uni) return uni as DOMRect
              }
              if (anchorElRef.current) {
                const rr = anchorElRef.current.getBoundingClientRect()
                const left = baseLeft ?? rr.left
                return { x: left, y: rr.top, left, top: rr.top, width: Math.max(1, rr.right - left), height: Math.max(1, rr.height || 1), right: rr.right, bottom: rr.bottom } as DOMRect
              }
              if (savedRangeRef.current) {
                const range = savedRangeRef.current
                const list = range.getClientRects()
                const rr = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
                const left = baseLeft ?? rr.left
                return { x: left, y: rr.top, left, top: rr.top, width: Math.max(1, rr.right - left), height: Math.max(1, rr.height || 1), right: rr.right, bottom: rr.bottom } as DOMRect
              }
            } catch {}
            return lastAnchorRectRef.current as any
          })()
          const h = (floatingElRef.current as any)?.offsetHeight || 0
          const gap = FLOATING_OFFSET
          if (r && h > 0) {
            const spaceAbove = r.top - contRect.top
            const spaceBelow = contRect.bottom - (r.top + r.height)
            const needAbove = spaceAbove >= h + gap + HYSTERESIS_PX
            const needBelow = spaceBelow >= h + gap + HYSTERESIS_PX
            setPlacement((prev) => {
              let next = prev
              if (prev === 'top-start') {
                if (!needAbove && needBelow) next = 'bottom-start'
                else if (!needAbove && !needBelow) next = spaceBelow > spaceAbove ? 'bottom-start' : 'top-start'
              } else {
                if (!needBelow && needAbove) next = 'top-start'
                else if (!needBelow && !needAbove) next = spaceAbove > spaceBelow ? 'top-start' : 'bottom-start'
              }
              return next
            })
          }
        }
      } catch {}
      try { update() } catch {}
    })
  }

  const refreshRef = () => {
    const computeAnchorRect = (): DOMRect | null => {
      // 仅 Markdown 模式需要基于元素/Range/备份的 rect 计算，同时对齐到内容左侧
      if (!mdPreview) return lastAnchorRectRef.current as any
      try {
        const baseLeft = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
        if (previewHostEl && activeMarkId) {
          const uni = getUnionRectByMarkId(previewHostEl, activeMarkId, baseLeft)
          if (uni) return uni as DOMRect
        }
        if (anchorElRef.current) {
          const r = anchorElRef.current.getBoundingClientRect()
          const left = baseLeft ?? r.left
          return {
            x: left,
            y: r.top,
            left,
            top: r.top,
            width: Math.max(1, r.right - left),
            height: Math.max(1, r.height || 1),
            right: r.right,
            bottom: r.bottom
          } as DOMRect
        }
        if (savedRangeRef.current) {
          const range = savedRangeRef.current
          const list = range.getClientRects()
          const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
          const left = baseLeft ?? r.left
          return {
            x: left,
            y: r.top,
            left,
            top: r.top,
            width: Math.max(1, r.right - left),
            height: Math.max(1, r.height || 1),
            right: r.right,
            bottom: r.bottom
          } as DOMRect
        }
        try {
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed) {
            const range = sel.getRangeAt(0)
            const list = range.getClientRects()
            const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
            const left = baseLeft ?? r.left
            return {
              x: left,
              y: r.top,
              left,
              top: r.top,
              width: Math.max(1, r.right - left),
              height: Math.max(1, r.height || 1),
              right: r.right,
              bottom: r.bottom
            } as DOMRect
          }
        } catch {}
        const r = lastAnchorRectRef.current!
        if (r && baseLeft != null) {
          const left = baseLeft
          return {
            x: left,
            y: r.y,
            left,
            top: r.y,
            width: Math.max(1, (r.width as any) || 1),
            height: Math.max(1, (r.height as any) || 1),
            right: left + Math.max(1, (r.width as any) || 1),
            bottom: r.y + Math.max(1, (r.height as any) || 1)
          } as DOMRect
        }
        return (r || null) as any
      } catch {
        return lastAnchorRectRef.current as any
      }
    }

    const v = {
      getBoundingClientRect: () => {
        if (mdPreview) {
          const r = computeAnchorRect()
          return (
            r ||
            ({ x: 0, y: 0, left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 } as DOMRect)
          )
        }
        const r = lastAnchorRectRef.current!
        return (
          r || ({ x: 0, y: 0, left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 } as DOMRect)
        )
      },
      contextElement: (mdPreview ? (previewScrollEl || containerEl) : containerEl) || undefined
    }
    ;(refs.setReference as any)(v)
    // Markdown 模式：依据边界与滞后阈值决定放置方向（top/bottom），避免边界附近来回翻转
    if (mdPreview) {
      try {
        const contRect =
          (previewScrollEl || containerEl)?.getBoundingClientRect() ||
          ({ top: 0, bottom: window.innerHeight } as any)
        const r = computeAnchorRect()
        const h = (floatingElRef.current as any)?.offsetHeight || 0
        const gap = FLOATING_OFFSET
        if (r && h > 0) {
          const spaceAbove = r.top - contRect.top
          const spaceBelow = contRect.bottom - (r.top + r.height)
          const needAbove = spaceAbove >= h + gap + HYSTERESIS_PX
          const needBelow = spaceBelow >= h + gap + HYSTERESIS_PX
          setPlacement((prev) => {
            let next = prev
            if (prev === 'top-start') {
              if (!needAbove && needBelow) next = 'bottom-start'
              else if (!needAbove && !needBelow)
                next = spaceBelow > spaceAbove ? 'bottom-start' : 'top-start'
            } else {
              if (!needBelow && needAbove) next = 'top-start'
              else if (!needBelow && !needAbove)
                next = spaceAbove > spaceBelow ? 'top-start' : 'bottom-start'
            }
            return next
          })
        }
      } catch {}
    }
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

  const refsEx = {
    ...refs,
    setFloating: (node: any) => {
      try { floatingElRef.current = node as any } catch {}
      try { (refs.setFloating as any)(node) } catch {}
    }
  }

  return {
    x,
    y,
    strategy,
    refs: refsEx,
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
