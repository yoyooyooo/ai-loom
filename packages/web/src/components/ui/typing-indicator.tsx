import { Dot } from 'lucide-react'

export function TypingIndicator() {
  return (
    <div className="flex justify-start space-x-1">
      <div className="rounded-lg bg-muted p-3">
        <div className="flex -space-x-2.5">
          <Dot className="h-5 w-5 animate-typing-dot-bounce delay-0" />
          <Dot className="h-5 w-5 animate-typing-dot-bounce delay-100" />
          <Dot className="h-5 w-5 animate-typing-dot-bounce delay-200" />
        </div>
      </div>
    </div>
  )
}
