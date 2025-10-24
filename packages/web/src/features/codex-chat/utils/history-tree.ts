import type { ConversationListItem } from '../services/api'

export type HistoryTreeNode = {
  item: ConversationListItem
  depth: number
  lineageDepth: number
}

export function buildHistoryTree(items: ConversationListItem[]): HistoryTreeNode[] {
  if (!items || items.length === 0) return []

  // 仅使用 conversationId 作为唯一键，不再做 path 兼容（开发期简化）
  const byId = new Map<string, ConversationListItem>()
  const childrenMap = new Map<string, ConversationListItem[]>()
  const roots: ConversationListItem[] = []

  const keyOf = (item: ConversationListItem) => item.conversationId ?? ''

  for (const item of items) {
    const key = keyOf(item)
    if (!key) continue
    byId.set(key, item)

    const parentId = item.parentId ?? undefined
    if (!parentId) {
      roots.push(item)
      continue
    }
    const list = childrenMap.get(parentId) ?? []
    list.push(item)
    childrenMap.set(parentId, list)
  }

  const attachToRoot = (node: ConversationListItem) => {
    const rootId = node.rootId
    if (!rootId) {
      roots.push(node)
      return
    }
    const rootItem = byId.get(rootId)
    if (rootItem) {
      // 将该节点挂到 rootItem 下；childrenMap 以 conversationId 为键
      const list = childrenMap.get(rootId) ?? []
      list.push(node)
      childrenMap.set(rootId, list)
      return
    }
    roots.push(node)
  }

  for (const item of items) {
    const parentId = item.parentId
    if (!parentId) continue
    if (!byId.has(parentId)) {
      attachToRoot(item)
    }
  }

  const result: HistoryTreeNode[] = []

  const sortByTimestampDesc = (a: ConversationListItem, b: ConversationListItem) => {
    const aTime = a.timestamp ?? a.createdAt ?? ''
    const bTime = b.timestamp ?? b.createdAt ?? ''
    if (aTime === bTime) return 0
    return aTime > bTime ? -1 : 1
  }

  const visit = (
    node: ConversationListItem,
    depth: number,
    lineageDepth: number,
    visiting: Set<string>
  ) => {
    result.push({ item: node, depth, lineageDepth })
    const k = keyOf(node)
    if (!k) return
    const children = (childrenMap.get(k) ?? []).slice()
    children.sort(sortByTimestampDesc)
    const nextVisiting = new Set(visiting)
    nextVisiting.add(k)
    for (const child of children) {
      const ck = keyOf(child)
      if (!ck || nextVisiting.has(ck)) continue // 避免自环或循环引用导致递归爆栈
      const lineage = typeof child.depth === 'number' ? child.depth : lineageDepth + 1
      visit(child, depth + 1, lineage, nextVisiting)
    }
  }

  roots.sort(sortByTimestampDesc)
  for (const root of roots) {
    visit(root, 0, root.depth ?? 0, new Set())
  }

  const visitedKeys = new Set(result.map((node) => keyOf(node.item)).filter(Boolean))
  const remaining = items.filter((item) => {
    const key = keyOf(item)
    return key && !visitedKeys.has(key)
  })

  if (remaining.length > 0) {
    remaining.sort(sortByTimestampDesc)
    for (const item of remaining) {
      visit(item, 0, item.depth ?? 0, new Set())
    }
  }

  return result
}
