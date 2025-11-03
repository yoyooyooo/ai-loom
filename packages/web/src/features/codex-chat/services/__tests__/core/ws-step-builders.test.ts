import { describe, it, expect } from 'vitest'
import {
  buildExecFallbackStepParts,
  buildPatchFromApplyPatchCommand,
  buildPatchToolBeginParts,
  buildMcpBeginParts,
  buildMcpEndMeta,
  buildSearchStepParts,
  buildListStepParts
} from '../../ws-step-builders'

describe('ws-step-builders', () => {
  it('buildExecFallbackStepParts', () => {
    const r = buildExecFallbackStepParts({
      command: ['bash', '-lc', 'echo hi'],
      cwd: '/tmp',
      callId: 'x'
    })
    expect(r.title).toBe('bash -lc echo hi (cwd=/tmp)')
    expect(r.meta.cwd).toBe('/tmp')
  })

  it('buildPatchFromApplyPatchCommand', () => {
    const patch = ['*** Begin Patch', '*** Add File: a.txt', '+hello', '*** End Patch']
    const r = buildPatchFromApplyPatchCommand({ command: patch, cwd: '/', callId: 'p1' })
    expect(r.title).toBe('patch a.txt')
    expect((r.meta as any).patch.adds).toBeGreaterThanOrEqual(1)
    expect(String(r.body || '')).toContain('*** Begin Patch')
  })

  it('buildPatchToolBeginParts', () => {
    const built = buildPatchToolBeginParts(
      {
        files: 1,
        firstPath: 'b.txt',
        adds: 2,
        dels: 1,
        changes: { 'b.txt': { update: { unified_diff: '--- a\n+++ b\n@@\n- old\n+ new' } } }
      },
      { patchMaxFiles: 16, patchMaxChars: 2000 },
      'p2'
    )
    expect(built.title).toBe('patch b.txt')
    expect((built.meta as any).patch.adds).toBe(2)
    expect(String(built.body || '')).toContain('+++')
  })

  it('buildPatchToolBeginParts derives counts when missing', () => {
    const built = buildPatchToolBeginParts(
      {
        firstPath: 'c.txt',
        changes: {
          'c.txt': { update: { unified_diff: '--- a\n+++ b\n@@\n- old\n+ new\n+ more' } }
        }
      },
      { patchMaxFiles: 16, patchMaxChars: 2000 },
      'p3'
    )
    expect((built.meta as any).patch.adds).toBe(2)
    expect((built.meta as any).patch.dels).toBe(1)
    expect((built.meta as any).patch.files).toBe(1)
  })

  it('mcp begin/end parts', () => {
    const b = buildMcpBeginParts({ server: 's', tool: 't', args: { q: 1 } }, 'm1')
    expect(b.title).toBe('s/t')
    expect((b.meta as any).server).toBe('s')
    const em = buildMcpEndMeta({ server: 's', tool: 't', result: { ok: true } })
    expect((em as any).tool).toBe('t')
    expect((em as any).result.ok).toBe(true)
  })

  it('search title includes flags suffix when provided', () => {
    const action: any = {
      kind: 'search',
      label: 'Search',
      target: '/repo/src',
      query: 'foo',
      flags: { ci: true, word: true, type: 'ts', glob: '*.ts', hidden: true }
    }
    const built = buildSearchStepParts(action, {
      command: ['rg', '-n', '-i', '-w', '-t', 'ts', '-g', '*.ts', '--hidden', 'foo', 'src'],
      cwd: '/repo',
      callId: 's1'
    })
    expect(built.title).toContain('Search foo in src')
    expect(built.title).toContain('(ci')
    expect(built.title).toContain('word')
    expect(built.title).toContain('type=ts')
    expect(built.title).toContain('glob=*.ts')
    expect(built.title).toContain('hidden')
  })

  it('list title includes flags (depth/type/recursive) when provided', () => {
    const action: any = {
      kind: 'list',
      label: 'List find',
      target: '/repo/hooks',
      flags: { depth: 2, type: 'f', recursive: true }
    }
    const built = buildListStepParts(action, {
      command: ['find', 'hooks', '-maxdepth', '2', '-type', 'f'],
      cwd: '/repo',
      callId: 'l1'
    })
    expect(built.title).toContain('List find hooks')
    expect(built.title).toContain('(depth=2')
    expect(built.title).toContain('type=f')
  })
})
