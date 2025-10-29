import { describe, expect, it } from 'vitest'
import {
  deriveResumeCapabilities,
  deriveResumeOverrides,
  normalizeApproval,
  normalizeSandbox
} from '@/features/codex-chat/utils/resume-config'

describe('resume-config helpers', () => {
  it('normalizes approval policy tokens', () => {
    expect(normalizeApproval('on-request')).toBe('on-request')
    expect(normalizeApproval('never')).toBe('never')
    expect(normalizeApproval('unknown')).toBeUndefined()
    expect(normalizeApproval(null)).toBeUndefined()
  })

  it('normalizes sandbox modes', () => {
    expect(normalizeSandbox('workspace-write')).toBe('workspace-write')
    expect(normalizeSandbox('danger-full-access')).toBe('danger-full-access')
    expect(normalizeSandbox('invalid')).toBeUndefined()
  })

  it('derives overrides with explicit codex overrides', () => {
    const overrides = deriveResumeOverrides({
      model: 'gpt-5',
      approvalPolicy: 'on-request',
      sandbox: {
        mode: 'workspace-write',
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: false,
        writableRoots: ['/Users/test/project']
      },
      overrides: {
        model: 'gpt-5-mini',
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
        config: {
          'sandbox_workspace_write.network_access': false
        }
      }
    })

    expect(overrides.model).toBe('gpt-5-mini')
    expect(overrides.approvalPolicy).toBe('never')
    expect(overrides.sandboxMode).toBe('workspace-write')
  })

  it('falls back to snapshot defaults when overrides missing', () => {
    const overrides = deriveResumeOverrides({
      model: 'o4',
      approvalPolicy: 'untrusted',
      sandbox: {
        mode: 'read-only'
      }
    })
    expect(overrides.model).toBe('o4')
    expect(overrides.approvalPolicy).toBe('untrusted')
    expect(overrides.sandboxMode).toBe('read-only')
  })

  it('derives capability patches with resume config snapshot', () => {
    const capabilities = deriveResumeCapabilities({
      model: 'gpt-5',
      overrides: {
        model: 'gpt-5-mini'
      }
    })
    expect(capabilities.providerId).toBe('codex')
    expect(capabilities.model).toBe('gpt-5')
    expect((capabilities.extra as any)?.resumeConfig?.model).toBe('gpt-5')
  })
})
