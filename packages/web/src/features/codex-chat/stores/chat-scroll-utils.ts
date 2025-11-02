import { animate, type AnimationPlaybackControls } from 'framer-motion'

export type SmoothScrollOpts = {
  nearDuration?: number
  farDuration?: number
  extraDuration?: number
  easing?: [number, number, number, number]
  interruptOnUser?: boolean
  // 锚点类滚动建议冻结目标，避免每帧测量引发回流
  freezeTo?: boolean
  onStart?: () => void
  onComplete?: () => void
}

export const CHAT_SCROLLER_ID = 'chat-turns-scroll'

export function smoothScrollElement(
  el: HTMLElement,
  getTo: () => number,
  opts: SmoothScrollOpts = {}
): AnimationPlaybackControls | null {
  const from = el.scrollTop
  const prefersReduced =
    typeof window !== 'undefined' &&
    (window as any)?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

  const toNow = getTo()
  const distance = Math.max(0, Math.abs(toNow - from))
  const nearDuration = opts.nearDuration ?? 0.33
  const farDuration = opts.farDuration ?? 0.41
  const extra = opts.extraDuration ?? 0
  const duration = (distance > 1600 ? farDuration : nearDuration) + extra
  const easing: [number, number, number, number] = opts.easing ?? [0.45, 0.08, 1.0, 1.0]

  if (prefersReduced) {
    el.scrollTop = getTo()
    opts.onComplete?.()
    return null
  }

  opts.onStart?.()
  try {
    el.setAttribute('data-smooth-scrolling', '1')
  } catch {}

  const controls = animate(0, 1, {
    duration,
    ease: easing,
    onUpdate: (progress) => {
      const to = opts.freezeTo ? toNow : getTo()
      el.scrollTop = from + (to - from) * progress
    },
    onComplete: () => {
      try {
        el.removeAttribute('data-smooth-scrolling')
      } catch {}
      opts.onComplete?.()
      // 触发一次滚动事件，便于外部监听方在动画结束后同步状态
      try {
        el.dispatchEvent(new Event('scroll'))
      } catch {}
    }
  })

  if (opts.interruptOnUser) {
    const cancel = () => {
      try {
        controls.stop()
      } catch {}
      try {
        el.removeAttribute('data-smooth-scrolling')
      } catch {}
      cleanup()
    }
    const cleanup = () => {
      try {
        el.removeEventListener('wheel', cancel)
        el.removeEventListener('touchstart', cancel)
        el.removeEventListener('pointerdown', cancel)
      } catch {}
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('touchstart', cancel, { passive: true })
    el.addEventListener('pointerdown', cancel, { passive: true })
  }

  return controls
}

export function getChatScroller(): HTMLElement | null {
  return (
    typeof document !== 'undefined' ? document.getElementById(CHAT_SCROLLER_ID) : null
  ) as HTMLElement | null
}

export function computeAlignTopScrollTop(scroller: HTMLElement, anchor: HTMLElement) {
  const crect = scroller.getBoundingClientRect()
  const trect = anchor.getBoundingClientRect()
  return scroller.scrollTop + (trect.top - crect.top)
}
