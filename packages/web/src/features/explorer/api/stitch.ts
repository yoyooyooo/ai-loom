import { http, toHttpError } from '@/lib/request'

export async function stitchGenerate(params: { templateId?: string; maxChars?: number; annotationIds?: string[] }): Promise<{ prompt: string; stats: any }> {
  const { templateId = 'concise', maxChars = 4000, annotationIds = [] } = params || {}
  try {
    const res = await http.post('/api/stitch', { annotationIds }, { params: { templateId, maxChars } })
    return res.data as { prompt: string; stats: any }
  } catch (e: any) { throw toHttpError(e, 'Failed to stitch') }
}

