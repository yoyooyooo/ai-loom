import type { Annotation, CreateAnnotation, UpdateAnnotation } from '@/lib/api/types'
import { http, toHttpError } from '@/lib/request'

export async function listAnnotations(): Promise<Annotation[]> {
  try {
    const res = await http.get('/api/annotations')
    return res.data as Annotation[]
  } catch (e: any) { throw toHttpError(e, 'Failed to list annotations') }
}

export async function createAnnotation(body: CreateAnnotation): Promise<Annotation> {
  try {
    const res = await http.post('/api/annotations', body)
    return res.data as Annotation
  } catch (e: any) { throw toHttpError(e, 'Failed to create annotation') }
}

export async function updateAnnotation(id: string, body: UpdateAnnotation): Promise<Annotation> {
  try {
    const res = await http.put('/api/annotations/' + encodeURIComponent(id), body)
    return res.data as Annotation
  } catch (e: any) { throw toHttpError(e, 'Failed to update annotation') }
}

export async function deleteAnnotation(id: string): Promise<{ ok: boolean }> {
  try {
    const res = await http.delete('/api/annotations/' + encodeURIComponent(id))
    return res.data as { ok: boolean }
  } catch (e: any) { throw toHttpError(e, 'Failed to delete annotation') }
}

export async function exportAnnotations(): Promise<any> {
  try {
    const res = await http.get('/api/annotations/export')
    return res.data
  } catch (e: any) { throw toHttpError(e, 'Failed to export annotations') }
}

export async function importAnnotations(payload: any): Promise<{ added: number; updated: number; skipped: number }> {
  try {
    const res = await http.post('/api/annotations/import', payload)
    return res.data as { added: number; updated: number; skipped: number }
  } catch (e: any) { throw toHttpError(e, 'Failed to import annotations') }
}

