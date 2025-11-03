import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, type AnimationPlaybackControls } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { ArrowDown } from 'lucide-react'
import {
  CHAT_SCROLLER_ID,
  smoothScrollElement
} from '@/features/codex-chat/stores/chat-scroll-utils'
import { useChatTurnStore, chatTurnSelectors } from '../stores/chat-turns'
import { TurnAssistantView, TurnUserView } from './turn-item'

type TurnsPanelProps = {
  onRetry?: (text: string) => void
}

export function TurnsPanel({ onRetry }: TurnsPanelProps = {}) {
  const conversationId = useChatTurnStore((state) => state.conversationId)
  const { turns, generating } = useChatTurnStore(chatTurnSelectors.currentSlice)
  const listRef = useRef<HTMLDivElement>(null)
  const [stickToBottom, setStickToBottom] = useState(true)
  const [distanceToBottom, setDistanceToBottom] = useState(0)
  const scrollAnim = useRef<AnimationPlaybackControls | null>(null)
  const isAnimating = useRef(false)
  const lastConvChangeAt = useRef(0)

  // 环境开关与阈值：可在调试中动态调参
  const AUTOSCROLL_DISABLE = useMemo(() => {
    try {
      const v = (import.meta as any).env?.VITE_CHAT_AUTOSCROLL_DISABLE
      if (v == null) return false
      const s = String(v).toLowerCase()
      return s === '1' || s === 'true' || s === 'yes'
    } catch {
      return false
    }
  }, [])
  const AUTOSCROLL_MIN_MS = useMemo(() => {
    try {
      const v = (import.meta as any).env?.VITE_CHAT_AUTOSCROLL_MIN_MS
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 120
    } catch {
      return 120
    }
  }, [])
  const AUTOSCROLL_MIN_DELTA = useMemo(() => {
    try {
      const v = (import.meta as any).env?.VITE_CHAT_AUTOSCROLL_MIN_DELTA
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 40 // 高度增长阈值（像素）
    } catch {
      return 40
    }
  }, [])

  // rAF 合并：避免同一帧内重复到底，减少布局测量与写入
  const scheduledRef = useRef(false)
  const lastForcedAt = useRef(0)
  const prevScrollHeight = useRef<number | null>(null)

  function scheduleScrollBottom(force = false) {
    if (AUTOSCROLL_DISABLE) return
    const el = listRef.current
    if (!el) return
    if (!force && !stickToBottom) return
    const now = performance.now()
    if (!force && now - lastForcedAt.current < AUTOSCROLL_MIN_MS) {
      // 已在冷却窗口内，延迟到窗口结束后再执行一次
      if (!scheduledRef.current) {
        scheduledRef.current = true
        setTimeout(
          () => {
            scheduledRef.current = false
            scheduleScrollBottom(false)
          },
          Math.max(0, AUTOSCROLL_MIN_MS - (now - lastForcedAt.current))
        )
      }
      return
    }
    if (scheduledRef.current) return
    scheduledRef.current = true
    requestAnimationFrame(() => {
      try {
        // 使用最新 scrollHeight（只测量一次）
        el.scrollTop = el.scrollHeight
        lastForcedAt.current = performance.now()
        prevScrollHeight.current = el.scrollHeight
      } finally {
        scheduledRef.current = false
      }
    })
  }

  const contentKey = useMemo(() => {
    try {
      return turns
        .map((t) =>
          [
            t.id,
            t.status,
            t.assistant?.text?.length || 0,
            t.steps?.length || 0,
            t.reasoning?.content?.length || 0
          ].join(':')
        )
        .join('|')
    } catch {
      return String(turns?.length || 0)
    }
  }, [turns])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    // 初始挂载：若刚发生会话切换，交由会话切换的稳定粘底逻辑处理，避免重复滚动
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - (lastConvChangeAt.current || 0) < 200) return
    // 否则，直接到底
    prevScrollHeight.current = el.scrollHeight
    el.scrollTop = el.scrollHeight
  }, [turns.length, generating])

  // 会话切换/首次打开：滚动到底，并开启粘底
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    setStickToBottom(true)
    // 记录会话切换时间，避免与挂载滚动重复
    lastConvChangeAt.current = typeof performance !== 'undefined' ? performance.now() : Date.now()
    // 稳定到底：在连续多个 rAF 帧中强制到底，直到高度稳定或达到最大尝试次数
    let tries = 0
    const MAX_TRIES = 8
    const settle = () => {
      const el2 = listRef.current
      if (!el2) return
      // 强制到底
      el2.scrollTop = el2.scrollHeight
      prevScrollHeight.current = el2.scrollHeight
      tries += 1
      if (tries >= MAX_TRIES) return
      // 下一帧再确认，捕捉异步布局（如代码高亮/图片加载）
      requestAnimationFrame(settle)
    }
    requestAnimationFrame(settle)
    return () => {}
  }, [conversationId])

  // 内容变化：在用户未上滑时自动粘底
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (!stickToBottom) return
    scheduleScrollBottom(false)
  }, [contentKey, stickToBottom])

  // 监听尺寸变化（如代码高亮/图片加载导致高度变化）→ 在 RAF 中节流回调，避免高频回流
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    let pending = false
    const ro = new ResizeObserver(() => {
      if (pending) return
      pending = true
      requestAnimationFrame(() => {
        pending = false
        if (!stickToBottom || isAnimating.current) return
        const curr = el.scrollHeight
        const prev = prevScrollHeight.current ?? curr
        const inc = curr - prev
        if (inc >= AUTOSCROLL_MIN_DELTA) {
          scheduleScrollBottom(false)
        }
        prevScrollHeight.current = curr
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [stickToBottom, AUTOSCROLL_MIN_DELTA])

  // 监听滚动，判断是否保持粘底
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        const d = el.scrollHeight - (el.scrollTop + el.clientHeight)
        const ds = (el.getAttribute('data-smooth-scrolling') || '') === '1'
        if (!isAnimating.current && !ds) {
          setDistanceToBottom(d)
          // 阈值：离底部 < 100px 视为粘底（且不展示按钮）；动画进行中不切换粘底状态
          setStickToBottom(!scrollAnim.current && d < 100)
        }
        ticking = false
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 用户主动滚动/触摸/按下时，立即中断正在进行的丝滑滚动
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const cancel = () => {
      scrollAnim.current?.stop?.()
      scrollAnim.current = null
      isAnimating.current = false
    }
    el.addEventListener('wheel', cancel, { passive: true })
    el.addEventListener('touchstart', cancel, { passive: true })
    el.addEventListener('pointerdown', cancel, { passive: true })
    return () => {
      el.removeEventListener('wheel', cancel)
      el.removeEventListener('touchstart', cancel)
      el.removeEventListener('pointerdown', cancel)
    }
  }, [])

  const showScrollToBottom = distanceToBottom > 100

  function smoothScrollTo(getTo: () => number, opts?: { toBottom?: boolean }) {
    const el = listRef.current
    if (!el) return
    scrollAnim.current?.stop?.()
    scrollAnim.current = null
    isAnimating.current = true
    const controls = smoothScrollElement(el, getTo, {
      interruptOnUser: true,
      // 更柔和一点：默认 near/far 已 +50ms；此处再轻微增加 10ms
      extraDuration: 0.01,
      easing: [0.45, 0.08, 1.0, 1.0],
      freezeTo: !opts?.toBottom,
      onComplete: () => {
        isAnimating.current = false
        const d = el.scrollHeight - (el.scrollTop + el.clientHeight)
        setDistanceToBottom(d)
        setStickToBottom(Boolean(opts?.toBottom) ? d < 100 : false)
      }
    })
    scrollAnim.current = controls
  }

  function smoothScrollToBottom() {
    const el = listRef.current
    if (!el) return
    const computeTo = () => el.scrollHeight - el.clientHeight
    smoothScrollTo(computeTo, { toBottom: true })
  }

  return (
    <div className="relative h-full">
      <div
        ref={listRef}
        id={CHAT_SCROLLER_ID}
        className="h-full space-y-3 overflow-x-hidden overflow-y-auto px-4 py-3"
      >
        {turns.map((turn) => (
          <React.Fragment key={turn.id}>
            <TurnUserView turn={turn} />
            <TurnAssistantView turn={turn} onRetry={onRetry} disableRetry={generating} />
          </React.Fragment>
        ))}
      </div>
      <AnimatePresence>
        {showScrollToBottom ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none absolute bottom-3 right-5 z-10"
          >
            <Button
              type="button"
              size="sm"
              onClick={smoothScrollToBottom}
              className="pointer-events-auto rounded-full shadow-lg cursor-pointer"
            >
              <ArrowDown className="mr-1 h-4 w-4" /> 回到当前
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default TurnsPanel
