import React, { useLayoutEffect, useRef } from 'react'
import { useChatTurnStore } from '../stores/chat-turns'
import { TurnAssistantView, TurnUserView } from './turn-item'

export function TurnsPanel() {
  const { turns, generating } = useChatTurnStore((state) => ({ turns: state.turns, generating: state.generating }))
  const listRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns.length, generating])

  return (
    <div ref={listRef} className="h-full space-y-3 overflow-auto px-4 py-3">
      {turns.map((turn) => (
        <React.Fragment key={turn.id}>
          <TurnUserView turn={turn} />
          <TurnAssistantView turn={turn} />
        </React.Fragment>
      ))}
    </div>
  )
}

export default TurnsPanel

