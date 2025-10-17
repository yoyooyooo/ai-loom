import { ANCHOR_LEFT_TWEAK } from '@/components/editor/constants'

export type DomRectLike = {
  x: number
  y: number
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

export function getBaseLeft(el: HTMLElement | null, tweak: number = ANCHOR_LEFT_TWEAK) {
  if (!el) return undefined
  try {
    const rect = el.getBoundingClientRect()
    const padLeft = parseFloat(getComputedStyle(el).paddingLeft || '0') || 0
    return rect.left + padLeft + (Number.isFinite(tweak) ? tweak : 0)
  } catch {
    return undefined
  }
}

export function getUnionRectByMarkId(hostEl: HTMLElement, markId: string, baseLeft?: number): DomRectLike | null {
  try {
    const nodes = hostEl.querySelectorAll(`[data-mark-id="${markId}"]`)
    if (!nodes || nodes.length === 0) return null
    let top = Number.POSITIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    let bottom = Number.NEGATIVE_INFINITY
    let firstLeft = Number.POSITIVE_INFINITY
    let firstTop = Number.POSITIVE_INFINITY
    nodes.forEach((n) => {
      const r = (n as HTMLElement).getBoundingClientRect()
      top = Math.min(top, r.top)
      right = Math.max(right, r.right)
      bottom = Math.max(bottom, r.bottom)
      if (r.top < firstTop || (r.top === firstTop && r.left < firstLeft)) {
        firstTop = r.top
        firstLeft = r.left
      }
    })
    const left = baseLeft ?? (isFinite(firstLeft) ? firstLeft : (nodes[0] as HTMLElement).getBoundingClientRect().left)
    return {
      x: left,
      y: top,
      left,
      top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      right,
      bottom
    }
  } catch {
    return null
  }
}

