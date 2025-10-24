import { describe, expect, it } from 'vitest'
import type { ConversationListItem } from '../services/api'
import { buildHistoryTree } from './history-tree'

const item = (
  partial: Partial<ConversationListItem> & { conversationId: string; path: string }
): ConversationListItem => ({
  conversationId: partial.conversationId,
  path: partial.path,
  preview: '',
  timestamp: partial.timestamp || partial.createdAt || '2025-10-25T00:00:00.000Z',
  model: null,
  parentId: partial.parentId,
  rootId: partial.rootId,
  depth: partial.depth,
  createdAt: partial.createdAt
})

describe('buildHistoryTree', () => {
  it('orders parent before child even when API order is reversed', () => {
    const child = item({
      conversationId: 'child',
      path: 'child',
      parentId: 'parent',
      createdAt: '2025-10-25T02:00:00.000Z'
    })
    const parent = item({
      conversationId: 'parent',
      path: 'parent',
      createdAt: '2025-10-25T01:00:00.000Z'
    })

    const result = buildHistoryTree([child, parent])
    expect(result.map((node) => node.item.conversationId)).toEqual(['parent', 'child'])
    expect(result.map((node) => node.depth)).toEqual([0, 1])
  })

  it('reattaches orphan node to available root when parent missing', () => {
    const root = item({
      conversationId: 'root',
      path: 'root',
      createdAt: '2025-10-25T01:00:00.000Z'
    })
    const orphan = item({
      conversationId: 'child',
      path: 'child',
      parentId: 'missing-parent',
      rootId: 'root',
      depth: 2,
      createdAt: '2025-10-25T01:30:00.000Z'
    })

    const result = buildHistoryTree([orphan, root])
    expect(result.map((node) => node.item.conversationId)).toEqual(['root', 'child'])
    expect(result.map((node) => node.depth)).toEqual([0, 1])
    expect(result[1].lineageDepth).toBe(2)
  })

  it('keeps unrelated roots separate', () => {
    const rootA = item({
      conversationId: 'rootA',
      path: 'rootA',
      createdAt: '2025-10-25T05:00:00.000Z'
    })
    const parent = item({
      conversationId: 'parent',
      path: 'parent',
      parentId: 'ancestor',
      createdAt: '2025-10-25T04:00:00.000Z'
    })
    const child = item({
      conversationId: 'child',
      path: 'child',
      parentId: 'parent',
      createdAt: '2025-10-25T04:30:00.000Z'
    })

    const result = buildHistoryTree([rootA, child, parent])
    expect(result.map((node) => node.item.conversationId)).toEqual(['rootA', 'parent', 'child'])
    expect(result.map((node) => node.depth)).toEqual([0, 0, 1])
  })

  it('treats missing parents as roots', () => {
    const child = item({ conversationId: 'child', path: 'child', parentId: 'ghost' })
    const result = buildHistoryTree([child])
    expect(result[0].depth).toBe(0)
  })

  it('handles self-referential parentId without recursion overflow', () => {
    const self = item({ conversationId: 'solo', path: 'solo', parentId: 'solo' })
    const result = buildHistoryTree([self])
    // 结果可接受两种：
    // - 作为残留节点经 remaining 补入（深度 0）
    // - 若将来逻辑调整，也应至少只有一个节点且不爆栈
    expect(result.length).toBe(1)
    expect(result[0].item.conversationId).toBe('solo')
    expect(result[0].depth).toBe(0)
  })
})
