export type DirEntry = {
  name: string
  path: string
  type: 'file' | 'dir' | 'File' | 'Dir'
  size?: number
}

export type FileChunk = {
  path: string
  language: string
  size: number
  totalLines: number
  startLine: number
  endLine: number
  content: string
  truncated: boolean
}

export type Annotation = {
  id: string
  filePath: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  selectedText: string
  comment: string
  preContextHash?: string
  postContextHash?: string
  fileDigest?: string
  tags?: string[]
  priority?: 'P0' | 'P1' | 'P2'
  createdAt: string
  updatedAt: string
}

export type CreateAnnotation = {
  filePath: string
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  selectedText: string
  comment: string
  preContextHash?: string
  postContextHash?: string
  fileDigest?: string
  tags?: string[]
  priority?: 'P0' | 'P1' | 'P2'
}

export type UpdateAnnotation = {
  filePath?: string
  startLine?: number
  endLine?: number
  startColumn?: number
  endColumn?: number
  selectedText?: string
  comment?: string
  preContextHash?: string
  postContextHash?: string
  fileDigest?: string
  tags?: string[]
  priority?: 'P0' | 'P1' | 'P2'
}
