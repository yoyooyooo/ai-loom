import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { StepIcon } from '@/features/codex-chat/components/cards/common'

describe('StepIcon (exec)', () => {
  it('renders terminal icon by default', () => {
    const step: any = { kind: 'exec', meta: { command: ['ls'] } }
    const { container } = render(<StepIcon kind="exec" step={step} />)
    expect(container.querySelector('svg.lucide-terminal')).toBeTruthy()
  })

  it('renders mv icon for direct mv command', () => {
    const step: any = { kind: 'exec', meta: { command: ['mv', 'a', 'b'] } }
    const { container } = render(<StepIcon kind="exec" step={step} />)
    expect(container.querySelector('svg.lucide-arrow-right-left')).toBeTruthy()
  })

  it('renders mv icon for bash -lc mv script', () => {
    const step: any = { kind: 'exec', meta: { command: ['bash', '-lc', 'mv src/file dest/file'] } }
    const { container } = render(<StepIcon kind="exec" step={step} />)
    expect(container.querySelector('svg.lucide-arrow-right-left')).toBeTruthy()
  })
})
