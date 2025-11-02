import React from 'react'
import { StepIcon, StepCardProps } from './common'

export function InfoCompactCard({ step }: StepCardProps) {
  return (
    <div className="border-b border-border pb-1">
      <div className="flex items-center gap-2 rounded px-1.5 py-1 text-xs">
        <StepIcon kind={step.kind} />
        <span className="truncate">{step.title}</span>
      </div>
    </div>
  )
}
