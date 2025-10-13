import { useState, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { TREE_CACHE_STALE_MS, TREE_CACHE_GC_MS } from '@/lib/config'
import type { DirEntry } from '@/lib/api/types'
import { fetchTree } from '@/features/explorer/api/tree'

type Node = DirEntry & { depth: number; expanded?: boolean; loaded?: boolean }

type Props = {
  root: string
  onOpenFile: (path: string) => void
  selectedPath?: string | null
}

export default function FileTree({ root, onOpenFile, selectedPath }: Props) {
  const [nodes, setNodes] = useState<Node[]>([])
  const storageKey = useMemo(() => `ailoom.fileTree.expanded:${root}`, [root])
  const expandedRef = useRef<Set<string>>(new Set())
  const qc = useQueryClient()

  function loadExpandedSet(): Set<string> {
    try {
      const raw = localStorage.getItem(storageKey)
      if (!raw) return new Set()
      return new Set(JSON.parse(raw) as string[])
    } catch { }
    return new Set()
  }
  function saveExpandedSet(setx: Set<string>) {
    try { localStorage.setItem(storageKey, JSON.stringify(Array.from(setx))) } catch {}
  }

  useEffect(() => {
    expandedRef.current = loadExpandedSet()
    ;(async () => {
      if (expandedRef.current.size === 0) {
        const top = await fetchTree(root)
        const topList: Node[] = top
          .sort(compareEntry)
          .map(c => ({ ...c, depth: 0 }))
        setNodes(topList)
        return
      }
      const list = await buildNodes(root, 0, expandedRef.current, 0)
      setNodes(list)
    })()
  }, [root])

  async function loadChildren(dir: string, depth: number, insertIndex?: number) {
    const children = await qc.ensureQueryData({
      queryKey: ['tree', root, dir],
      queryFn: () => fetchTree(dir),
      staleTime: TREE_CACHE_STALE_MS,
      gcTime: TREE_CACHE_GC_MS,
    })
    const list: Node[] = children
      .filter(c => true)
      .sort(compareEntry)
      .map(c => ({ ...c, depth }))
    setNodes(prev => {
      if (insertIndex == null) return list
      const next = prev.slice()
      next.splice(insertIndex, 0, ...list)
      return next
    })
  }

  async function buildNodes(dir: string, depth: number, expandSet: Set<string>, defaultDepth: number): Promise<Node[]> {
    const children = await qc.ensureQueryData({
      queryKey: ['tree', root, dir],
      queryFn: () => fetchTree(dir),
      staleTime: TREE_CACHE_STALE_MS,
      gcTime: TREE_CACHE_GC_MS,
    })
    const sorted = children
      .sort(compareEntry)
    const out: Node[] = []
    for (const c of sorted) {
      const isDir = c.type === 'dir' || c.type === 'Dir'
      if (!isDir) { out.push({ ...c, depth }) ; continue }
      const expanded = expandSet.has(c.path) || (defaultDepth > 0 && depth < defaultDepth)
      out.push({ ...c, depth, expanded })
      if (expanded) {
        const sub = await buildNodes(c.path, depth + 1, expandSet, defaultDepth)
        out.push(...sub)
      }
    }
    return out
  }

  async function expandPath(path: string) {
    const children = await fetchTree(path)
    setNodes(prev => {
      const idx = prev.findIndex(nn => nn.path === path)
      if (idx < 0) return prev
      const n = prev[idx]
      const isDir = n.type === 'dir' || n.type === 'Dir'
      if (!isDir || n.expanded) return prev
      const depth = n.depth + 1
      const list: Node[] = children
        .sort(compareEntry)
        .map(c => ({ ...c, depth }))
      const next = prev.slice()
      next[idx] = { ...n, expanded: true }
      next.splice(idx+1, 0, ...list)
      return next
    })
  }

  const findIndexByPath = (p: string) => nodes.findIndex(nn => nn.path === p)

  const toggle = async (idx: number) => {
    const n = nodes[idx]
    if (!n) return
    const isDir = n.type === 'dir' || n.type === 'Dir'
    if (!isDir) { onOpenFile(n.path); return }
    if (n.expanded) {
      const depth = n.depth
      let end = idx + 1
      while (end < nodes.length && nodes[end].depth > depth) end++
      const removed = nodes.slice(idx+1, end)
      const next = nodes.slice()
      next.splice(idx+1, end - (idx+1))
      next[idx] = { ...n, expanded: false }
      setNodes(next)
      const setx = expandedRef.current
      setx.delete(n.path)
      for (const r of removed) { setx.delete(r.path) }
      saveExpandedSet(setx)
    } else {
      await expandPath(n.path)
      const setx = expandedRef.current; setx.add(n.path); saveExpandedSet(setx)
    }
  }
  return (
    <div className="text-sm select-none">
      <ul>
        {nodes.map((n, i) => {
          const isDir = n.type === 'dir' || n.type === 'Dir'
          return (
            <li key={n.path} className={`flex items-center gap-1 rounded px-1 ${selectedPath === n.path ? 'bg-black/10' : 'hover:bg-black/5'}`}>
              <button className="text-left flex-1 flex items-center gap-1 py-1 w-full" onClick={()=>toggle(i)}>
                <span className="inline-block" style={{ width: n.depth * 12 }} />
                {isDir ? (
                  <span className="inline-block w-4 text-center">{n.expanded ? '▾' : '▸'}</span>
                ) : (
                  <span className="inline-block w-4" />
                )}
                <span className={`${isDir ? 'font-medium' : ''} ${selectedPath === n.path ? 'text-blue-600' : ''}`}>{n.name}</span>
              </button>
              {n.size != null && !isDir && <span className="text-xs opacity-50">{formatSize(n.size)}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function formatSize(n: number) {
  if (n < 1024) return n + 'B'
  if (n < 1024*1024) return (n/1024).toFixed(1)+'KB'
  return (n/1024/1024).toFixed(1)+'MB'
}

function isDirEntry(e: DirEntry) {
  return e.type === 'dir' || e.type === 'Dir'
}

function compareEntry(a: DirEntry, b: DirEntry) {
  const ad = isDirEntry(a)
  const bd = isDirEntry(b)
  if (ad && !bd) return -1
  if (!ad && bd) return 1
  if (ad && bd) {
    const aIsVS = a.name === '.vscode'
    const bIsVS = b.name === '.vscode'
    if (aIsVS && !bIsVS) return -1
    if (!aIsVS && bIsVS) return 1
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}
