import { useEffect, useRef, useState } from 'react'
import { useFloating, offset, autoUpdate } from '@floating-ui/react'
import type { AnchorRect } from '@/components/editor/types'
import { ANCHOR_LEFT_TWEAK, FLOATING_OFFSET } from '@/components/editor/constants'
import { getBaseLeft, getUnionRectByMarkId } from '@/components/editor/utils'

export function useMarkdownFloatingAnnotation(params: {
  containerEl: HTMLElement | null
  previewHostEl: HTMLElement | null
  previewScrollEl: HTMLElement | null
  show: boolean
  activeMarkId: string | null
}) {
  const { containerEl, previewHostEl, previewScrollEl, show, activeMarkId } = params
  const debug = (() => {
    try {
      const v =
        (typeof window !== 'undefined' && window.localStorage?.getItem('AILOOM_DEBUG_MD_FLOAT')) ||
        ''
      return v === '1' || v === 'true'
    } catch {
      return false
    }
  })()
  const dlog = (...args: any[]) => {
    try {
      if (debug) console.log('[md-float]', ...args)
    } catch {}
  }

  const [rectState, setRectState] = useState<AnchorRect | null>(null)
  const lastAnchorRectRef = useRef<AnchorRect | null>(null)
  const lastGoodRectRef = useRef<AnchorRect | null>(null)
  const anchorBaseRef = useRef<{
    x: number
    y: number
    scrollTop: number
    width: number
    height: number
  } | null>(null)
  const anchorElRef = useRef<HTMLElement | null>(null)
  const [hasAnchor, setHasAnchor] = useState(false)
  const [coordsReady, setCoordsReady] = useState(false)
  const floatingElRef = useRef<HTMLElement | null>(null)
  const [placement, setPlacement] = useState<'top-start' | 'bottom-start'>('top-start')
  // 滞后阈值：避免边界附近轻微滚动来回翻转
  const HYSTERESIS_PX = 12
  const savedRangeRef = useRef<Range | null>(null)
  const rafRef = useRef<number | null>(null)

  const strategyPref = (() => {
    try {
      const s =
        (typeof window !== 'undefined' &&
          window.localStorage?.getItem('AILOOM_MD_FLOAT_STRATEGY')) ||
        ''
      if (s === 'abs') return 'absolute'
      if (s === 'fix') return 'fixed'
      return 'absolute' // 默认使用 absolute 相对 overlay，更稳妥
    } catch {
      return 'absolute'
    }
  })() as 'fixed' | 'absolute'

  const { x, y, strategy, refs, update } = useFloating({
    placement,
    // Markdown：手动阈值翻转，不启用 flip/shift
    middleware: [offset(FLOATING_OFFSET)],
    strategy: strategyPref,
    whileElementsMounted: (reference, floating, u) => autoUpdate(reference, floating, u)
  })

  useEffect(() => {
    dlog('strategy', strategyPref)
  }, [])

  const scheduleUpdate = () => {
    try {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    } catch {}
    rafRef.current = requestAnimationFrame(() => {
      try {
        // 每次更新前重算翻转方向（带滞后阈值）
        const contRect =
          (previewScrollEl || containerEl)?.getBoundingClientRect() ||
          ({ top: 0, bottom: window.innerHeight } as any)
        const r = computeAnchorRect()
        // 仅在候选矩形“合理”时发布并记为 lastGood；否则沿用上一帧
        if (r && isRectSane(r)) {
          const rr = {
            x: r.x ?? (r as any).left ?? 0,
            y: r.y ?? (r as any).top ?? 0,
            width: Math.max(1, r.width || 1),
            height: Math.max(1, r.height || 1)
          }
          lastGoodRectRef.current = rr
          setRectState(rr)
          dlog('rect:publish', rr)
        } else if (lastGoodRectRef.current) {
          setRectState(lastGoodRectRef.current)
          dlog('rect:keep-last', lastGoodRectRef.current)
        }
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
      try {
        update()
      } catch {}
    })
  }

  function isRectSane(r: any) {
    try {
      const h = (() => {
        if (!r) return 0
        if (typeof r.height === 'number') return r.height
        if (typeof r.bottom === 'number' && typeof r.top === 'number') return r.bottom - r.top
        return 0
      })()
      return Number.isFinite(h) && h >= 8
    } catch {
      return false
    }
  }

  function computeAnchorRect(): DOMRect | null {
    try {
      const baseLeft = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
      // 1) 优先使用 Range（更贴近选区）
      if (savedRangeRef.current) {
        const range = savedRangeRef.current
        const list = range.getClientRects()
        const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
        if (isRectSane(r)) {
          const left = baseLeft ?? r.left
          const out = {
            x: left,
            y: r.top,
            left,
            top: r.top,
            width: Math.max(1, r.width || r.right - r.left || 1),
            height: Math.max(1, r.height || 1),
            right: left + Math.max(1, r.width || r.right - r.left || 1),
            bottom: r.top + Math.max(1, r.height || 1)
          } as DOMRect
          dlog('rect:from-range', out)
          return out
        } else {
          dlog('rect:from-range invalid', r)
        }
      }
      // 2) 使用锚点元素（祖先 data-sourcepos 节点）
      if (anchorElRef.current) {
        const r = anchorElRef.current.getBoundingClientRect()
        if (isRectSane(r)) {
          const left = baseLeft ?? r.left
          const out = {
            x: left,
            y: r.top,
            left,
            top: r.top,
            width: Math.max(1, r.width || r.right - r.left || 1),
            height: Math.max(1, r.height || 1),
            right: left + Math.max(1, r.width || r.right - r.left || 1),
            bottom: r.top + Math.max(1, r.height || 1)
          } as DOMRect
          dlog('rect:from-el', out)
          return out
        } else {
          dlog('rect:from-el invalid', r)
        }
      }
      // 3) 点击高亮的场景：合并多段内联标注的矩形
      if (previewHostEl && activeMarkId) {
        const uni = getUnionRectByMarkId(previewHostEl, activeMarkId, baseLeft)
        if (uni) {
          dlog('rect:from-union', uni)
          return uni as DOMRect
        }
      }
      // 4) window.getSelection 兜底
      try {
        const sel = window.getSelection()
        if (sel && !sel.isCollapsed) {
          const range = sel.getRangeAt(0)
          const list = range.getClientRects()
          const r = list && list.length > 0 ? list[0] : range.getBoundingClientRect()
          if (isRectSane(r)) {
            const left = baseLeft ?? r.left
            const out = {
              x: left,
              y: r.top,
              left,
              top: r.top,
              width: Math.max(1, r.width || r.right - r.left || 1),
              height: Math.max(1, r.height || 1),
              right: left + Math.max(1, r.width || r.right - r.left || 1),
              bottom: r.top + Math.max(1, r.height || 1)
            } as DOMRect
            dlog('rect:from-window-selection', out)
            return out
          } else {
            dlog('rect:from-window-selection invalid', r)
          }
        }
      } catch {}
      // 5) 最后回退到首次 anchorRect（携带滚动跟随）
      const r = lastAnchorRectRef.current
      if (r) {
        const baseLeft2 = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
        const baseX = anchorBaseRef.current?.x
        const left = baseX != null ? baseX : (baseLeft2 ?? r.x)
        const sc = previewScrollEl
        const curTop = (sc ? sc.scrollTop : (window as any)?.scrollY || 0) as number
        const base = anchorBaseRef.current
        const top = base ? base.y - (curTop - base.scrollTop) : r.y
        const w = Math.max(1, (base?.width ?? r.width) || 1)
        const h = Math.max(1, (base?.height ?? r.height) || 1)
        const out = {
          x: left,
          y: top,
          left,
          top,
          width: w,
          height: h,
          right: left + w,
          bottom: top + h
        } as DOMRect
        dlog('rect:from-last', out)
        return out
      }
      return null
    } catch {
      dlog('rect:error; using last')
      const r = lastAnchorRectRef.current
      if (!r) return null
      const left = r.x,
        top = r.y
      const w = Math.max(1, r.width || 1),
        h = Math.max(1, r.height || 1)
      return {
        x: left,
        y: top,
        left,
        top,
        width: w,
        height: h,
        right: left + w,
        bottom: top + h
      } as DOMRect
    }
  }

  const refreshRef = () => {
    const v = {
      getBoundingClientRect: () => {
        const r = computeAnchorRect()
        const ret =
          r ||
          ({
            x: -10000,
            y: -10000,
            left: -10000,
            top: -10000,
            width: 1,
            height: 1,
            right: -9999,
            bottom: -9999
          } as DOMRect)
        dlog('getBoundingClientRect ->', ret)
        return ret
      },
      contextElement: previewScrollEl || containerEl || undefined
    }
    ;(refs.setReference as any)(v)
    scheduleUpdate()
  }

  useEffect(() => {
    if (!show) return
    // 预览模式：需等待命中元素或首个 anchorRect 就绪，避免首帧错误定位
    if (!anchorElRef.current && !lastAnchorRectRef.current) return
    setHasAnchor(true)
    refreshRef()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, containerEl, previewHostEl, previewScrollEl, activeMarkId])

  useEffect(() => {
    if (!show || !hasAnchor) {
      setCoordsReady(false)
      return
    }
    // 仅当计算得到的坐标不是 0/0 或离屏 sentinel 时才认为就绪
    const ok = x != null && y != null && !(x === 0 && y === 0) && !(x! <= -9999 && y! <= -9999)
    dlog('coords', { x, y, ok, hasAnchor })
    setCoordsReady(!!ok)
  }, [x, y, show, hasAnchor])

  useEffect(() => {
    if (!show) {
      setHasAnchor(false)
      setCoordsReady(false)
    }
  }, [show])

  useEffect(() => {
    if (!show) return
    const sc = previewScrollEl
    if (!sc) return
    const onScroll = () => {
      dlog('scroll')
      scheduleUpdate()
    }
    sc.addEventListener('scroll', onScroll, { passive: true })
    const onWinScroll = () => {
      dlog('win-scroll')
      scheduleUpdate()
    }
    window.addEventListener('scroll', onWinScroll, true)
    const onResize = () => {
      dlog('resize')
      scheduleUpdate()
    }
    window.addEventListener('resize', onResize)
    return () => {
      sc.removeEventListener('scroll', onScroll)
      window.removeEventListener('scroll', onWinScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [show, previewScrollEl, update])

  useEffect(() => {
    if (!show) return
    const host = previewHostEl
    if (!host) return
    const ro = new ResizeObserver(() => {
      scheduleUpdate()
    })
    try {
      ro.observe(host)
    } catch {}
    return () => {
      try {
        ro.disconnect()
      } catch {}
    }
  }, [show, previewHostEl, update])

  // 针对异步内容变化的增强：
  // 1) 图片加载完成时重新测量
  // 2) DOM 插入新图片时为其绑定 onload
  // 3) CSS 过渡结束时重新测量（如图片渐显/容器展开）
  useEffect(() => {
    if (!show) return
    const host = previewHostEl
    if (!host) return
    const onImgLoad = () => {
      scheduleUpdate()
    }
    const attachImgListeners = (root: HTMLElement) => {
      try {
        const imgs = root.querySelectorAll('img')
        imgs.forEach((img) => {
          try {
            img.addEventListener('load', onImgLoad as any, { passive: true } as any)
          } catch {
            img.addEventListener('load', onImgLoad as any)
          }
        })
      } catch {}
    }
    const detachImgListeners = (root: HTMLElement) => {
      try {
        const imgs = root.querySelectorAll('img')
        imgs.forEach((img) => {
          try {
            img.removeEventListener('load', onImgLoad as any)
          } catch {}
        })
      } catch {}
    }
    attachImgListeners(host)
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes?.forEach((n) => {
          if (!(n instanceof HTMLElement)) return
          if (n.tagName === 'IMG') {
            try {
              ;(n as HTMLImageElement).addEventListener(
                'load',
                onImgLoad as any,
                { passive: true } as any
              )
            } catch {
              ;(n as HTMLImageElement).addEventListener('load', onImgLoad as any)
            }
          } else {
            attachImgListeners(n)
          }
        })
      }
    })
    try {
      mo.observe(host, { childList: true, subtree: true })
    } catch {}
    const onTransitionEnd = () => {
      scheduleUpdate()
    }
    try {
      host.addEventListener('transitionend', onTransitionEnd, true)
    } catch {}
    return () => {
      try {
        host.removeEventListener('transitionend', onTransitionEnd, true)
      } catch {}
      try {
        mo.disconnect()
      } catch {}
      detachImgListeners(host)
    }
  }, [show, previewHostEl])

  const refsEx = {
    ...refs,
    setFloating: (node: any) => {
      try {
        floatingElRef.current = node as any
      } catch {}
      try {
        ;(refs.setFloating as any)(node)
      } catch {}
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
      lastGoodRectRef.current = rect
      try {
        const sc = previewScrollEl
        const st = (sc ? sc.scrollTop : (window as any)?.scrollY || 0) as number
        const baseLeft0 = getBaseLeft(previewHostEl || containerEl, ANCHOR_LEFT_TWEAK)
        anchorBaseRef.current = {
          x: baseLeft0 != null ? baseLeft0 : rect.x,
          y: rect.y,
          scrollTop: st,
          width: rect.width,
          height: rect.height
        }
      } catch {}
      dlog('setAnchorRect', rect)
      setHasAnchor(true)
      setRectState(rect)
      refreshRef()
    },
    setAnchorEl: (el: HTMLElement | null) => {
      anchorElRef.current = el
      if (el) setHasAnchor(true)
      dlog('setAnchorEl', !!el)
      refreshRef()
    },
    setAnchorRange: (range: Range | null) => {
      savedRangeRef.current = range
      if (range) setHasAnchor(true)
      dlog('setAnchorRange', !!range)
      refreshRef()
    }
  }
}
