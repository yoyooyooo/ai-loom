import { describe, it, expect } from 'vitest'
import {
  buildReadStepParts,
  buildListStepParts,
  buildSearchStepParts
} from '../../services/ws-step-builders'

describe('exec 动作步骤构建（read/list/search）', () => {
  it('read → 标题与 meta', () => {
    const action = { kind: 'read' as const, path: '/a/b/c/file.ts', start: 10, end: 20 }
    const r = buildReadStepParts(action, {
      command: ['sed', '-n', "'10,20p'", '/a/b/c/file.ts'],
      cwd: '/a',
      callId: 'id1'
    })
    expect(r.title).toBe('Read file.ts (lines: 10-20)')
    expect(r.meta.file).toBe('/a/b/c/file.ts')
    expect(r.tags).toEqual(['file.ts'])
  })

  it('list → 目标名与标签', () => {
    const action = { kind: 'list' as const, label: 'List ls', target: '/x/y/z' }
    const r = buildListStepParts(action, {
      command: ['ls', '-la', '/x/y/z'],
      cwd: '/',
      callId: 'id2'
    })
    expect(r.title).toBe('List ls z')
    expect(r.meta.target).toBe('/x/y/z')
    expect(r.tags).toEqual(['z'])
  })

  it('search（rg -n -o 带引号）→ 纠正 query 与目标', () => {
    const cmd = [
      'bash',
      '-lc',
      'rg -n -o "get/figmaToken" "/Users/y/.vscode/extensions/kombai.kombai-1.4.207/bundle.js" | sed -n 1,60p'
    ]
    // 故意给一个被误判为 "o" 的 query，函数应当从命令中恢复为 get/figmaToken，并提取目标文件名
    const action = { kind: 'search' as const, label: 'Search', query: 'o', target: undefined }
    const r = buildSearchStepParts(action, { command: cmd, cwd: '/', callId: 'id3' })
    expect(r.title).toContain('Search get/figmaToken')
    expect(r.title).toContain('bundle.js')
    expect(r.meta.query).toBe('get/figmaToken')
    expect(r.meta.target?.endsWith('bundle.js')).toBe(true)
  })
})
