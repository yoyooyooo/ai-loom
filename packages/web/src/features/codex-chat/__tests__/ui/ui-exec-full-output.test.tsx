import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ExecStepCard } from '@/features/codex-chat/components/cards/exec-step-card'
import { appendExecOutput } from '@/features/codex-chat/stores/exec-output-vault'

describe('UI：执行步骤截断后的完整输出查看', () => {
  beforeEach(() => {
    // no-op
  })
  afterEach(() => {
    // no-op
  })

  it('截断时显示“查看完整输出”，点击后展开完整正文', async () => {
    const callId = 'c-full-1'
    const step: any = {
      id: 'step-1',
      kind: 'exec',
      title: 'bash -lc echo',
      status: 'completed',
      ts: new Date().toISOString(),
      meta: { truncated: true, totalLength: 123456, maxLength: 100000, callId },
      body: 'head...\n…(truncated, total=123456)\n...tail'
    }
    appendExecOutput(callId, 'FULL-CONTENT-EXAMPLE')
    render(<ExecStepCard step={step} />)
    const btn = screen.getByText('查看完整输出（可能很长）')
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    expect(await screen.findByText(/FULL-CONTENT-EXAMPLE/)).toBeTruthy()
    // 再次点击收起
    fireEvent.click(btn)
    expect(screen.queryByText(/FULL-CONTENT-EXAMPLE/)).toBeNull()
  })
})
