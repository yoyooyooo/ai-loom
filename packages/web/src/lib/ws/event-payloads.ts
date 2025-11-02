import type { Annotation } from '@/lib/api/types'

// Common meta added by server hub
export type WsMeta = { eventId?: string | number; ts?: string }

export type FileChangedPayload = WsMeta & {
  path: string
  kind: 'created' | 'modified' | 'deleted' | 'moved'
  digest?: string
  fromPath?: string
}

export type TreeChangedPayload = WsMeta & {
  dir?: string
  impactedPaths?: string[]
  summary?: {
    created: number
    modified: number
    deleted: number
    moved: number
    truncated: boolean
  }
}

export type AnnotationsCreatedPayload = WsMeta & { annotation: Annotation }
export type AnnotationsUpdatedPayload = WsMeta & { annotation: Annotation }
export type AnnotationsDeletedPayload = WsMeta & { id: string }
export type AnnotationsVerifyDonePayload = WsMeta & {
  checked?: number
  updated?: number
  deleted?: number
  skipped?: number
  updatedIds?: string[]
  deletedIds?: string[]
  skippedIds?: string[]
}

export type SessionResyncPayload = { reason?: string }
