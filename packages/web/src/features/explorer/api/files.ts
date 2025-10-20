import type { FileChunk } from '@/lib/api/types'
import { http, toHttpError } from '@/lib/request'
import { ws } from '@/lib/ws/singleton'
import { wsPrefer } from '@/lib/ws/query-helpers'

export async function fetchFileChunk(params: {
  path: string
  startLine: number
  maxLines: number
}): Promise<FileChunk> {
  const { path, startLine, maxLines } = params
  try {
    return await wsPrefer<FileChunk>(
      'file.getChunk',
      { path, startLine, maxLines },
      async (signal) => {
        const res = await http.get('/api/file', { params: { path, startLine, maxLines }, signal })
        return res.data as FileChunk
      }
    )
  } catch (e: any) {
    throw toHttpError(e, 'Failed to load file')
  }
}

export async function fetchFileFull(
  path: string
): Promise<{ path: string; language: string; size: number; content: string; digest: string }> {
  try {
    return await wsPrefer(
      'file.getFull',
      { path },
      async (signal) => {
        const res = await http.get('/api/file/full', { params: { path }, signal })
        return res.data as {
          path: string
          language: string
          size: number
          content: string
          digest: string
        }
      }
    )
  } catch (e: any) {
    throw toHttpError(e, 'Failed to load full file')
  }
}

export async function saveFile(params: {
  path: string
  content: string
  baseDigest?: string
}): Promise<{ ok: boolean; digest?: string }> {
  const WANT_WS = (() => {
    const v = (import.meta as any).env?.VITE_WS_WRITE
    if (v == null) return false
    const s = String(v).toLowerCase()
    return s === '1' || s === 'true'
  })()
  const tryWsFirst = WANT_WS && ws.enabled
  const doRest = async () => {
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
  if (tryWsFirst) {
    // 通过 wsPrefer 走 WS，发生传输类错误时自动回退 REST；CONFLICT 等业务错误直接抛出
    return await wsPrefer<{ ok: boolean; digest?: string }>(
      'file.save',
      params,
      doRest,
      { timeoutMs: 15000 }
    ).catch((e: any) => {
      if (String(e?.message || '').startsWith('CONFLICT:') || e?.code === 'CONFLICT') throw e
      throw e
    })
  }
  return await doRest()
}
