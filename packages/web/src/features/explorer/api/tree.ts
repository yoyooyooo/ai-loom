import type { DirEntry } from '@/lib/api/types'
import { http, toHttpError } from '@/lib/request'

export async function fetchTree(dir: string): Promise<DirEntry[]> {
  try {
    const res = await http.get('/api/tree', { params: { dir } })
    return res.data as DirEntry[]
  } catch (e: any) { throw toHttpError(e, 'Failed to load tree') }
}

