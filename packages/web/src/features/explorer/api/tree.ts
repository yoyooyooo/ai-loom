import type { DirEntry } from '@/lib/api/types'
import { http, toHttpError } from '@/lib/request'
import { wsPrefer } from '@/lib/ws/query-helpers'

export async function fetchTree(dir: string): Promise<DirEntry[]> {
  try {
    return await wsPrefer<DirEntry[]>('tree.get', { dir }, async (signal) => {
      const res = await http.get('/api/tree', { params: { dir }, signal })
      return res.data as DirEntry[]
    })
  } catch (e: any) {
    throw toHttpError(e, 'Failed to load tree')
  }
}
