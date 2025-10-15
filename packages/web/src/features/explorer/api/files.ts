import type { FileChunk } from '@/lib/api/types'
import { http, toHttpError } from '@/lib/request'

export async function fetchFileChunk(params: {
  path: string
  startLine: number
  maxLines: number
}): Promise<FileChunk> {
  const { path, startLine, maxLines } = params
  try {
    const res = await http.get('/api/file', { params: { path, startLine, maxLines } })
    return res.data as FileChunk
  } catch (e: any) {
    throw toHttpError(e, 'Failed to load file')
  }
}

export async function fetchFileFull(
  path: string
): Promise<{ path: string; language: string; size: number; content: string; digest: string }> {
  try {
    const res = await http.get('/api/file/full', { params: { path } })
    return res.data as {
      path: string
      language: string
      size: number
      content: string
      digest: string
    }
  } catch (e: any) {
    throw toHttpError(e, 'Failed to load full file')
  }
}

export async function saveFile(params: {
  path: string
  content: string
  baseDigest?: string
}): Promise<{ ok: boolean; digest?: string }> {
  try {
    const res = await http.put('/api/file', params)
    return res.data as { ok: boolean; digest?: string }
  } catch (e: any) {
    const status = e?.response?.status
    const data = e?.response?.data
    if (status === 409) {
      const cur = data?.error?.currentDigest || ''
      throw new Error('CONFLICT:' + cur)
    }
    throw toHttpError(e, 'Failed to save')
  }
}
