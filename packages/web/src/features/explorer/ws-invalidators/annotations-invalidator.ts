import type { QueryClient } from '@tanstack/react-query'
import { ws } from '@/lib/ws/singleton'

export function installAnnotationsInvalidator(qc: QueryClient) {
  if (!ws.enabled) return () => {}

  const subs = [
    ws.notification$('annotations.created').subscribe((p: any) => onAnnCreated(qc, p)),
    ws.notification$('annotations.updated').subscribe((p: any) => onAnnUpdated(qc, p)),
    ws.notification$('annotations.deleted').subscribe((p: any) => onAnnDeleted(qc, p)),
    ws.notification$('annotations.verify.done').subscribe(() => scheduleAnn(qc))
  ]

  return () => { for (const s of subs) { try { s.unsubscribe() } catch {} } }
}

function scheduleAnn(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['annotations'] })
}

function onAnnCreated(qc: QueryClient, p: any) {
  const ann = p?.annotation
  if (!ann || !ann.id) return scheduleAnn(qc)
  qc.setQueryData(['annotations'], (prev: any) => {
    const list: any[] = Array.isArray(prev) ? prev.slice() : []
    if (!list.find((a) => a?.id === ann.id)) list.unshift(ann)
    return list
  })
}

function onAnnUpdated(qc: QueryClient, p: any) {
  const ann = p?.annotation
  if (!ann || !ann.id) return scheduleAnn(qc)
  qc.setQueryData(['annotations'], (prev: any) => {
    const list: any[] = Array.isArray(prev) ? prev.slice() : []
    const idx = list.findIndex((a) => a?.id === ann.id)
    if (idx >= 0) list[idx] = ann
    else list.unshift(ann)
    return list
  })
}

function onAnnDeleted(qc: QueryClient, p: any) {
  const id = p?.id
  if (!id) return scheduleAnn(qc)
  qc.setQueryData(['annotations'], (prev: any) => {
    const list: any[] = Array.isArray(prev) ? prev.slice() : []
    const next = list.filter((a) => a?.id !== id)
    return next
  })
}

