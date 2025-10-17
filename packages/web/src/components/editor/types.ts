export type AnchorRect = { x: number; y: number; width: number; height: number }

export type ViewerSelection = {
  startLine: number
  endLine: number
  startColumn?: number
  endColumn?: number
  selectedText: string
  anchorRect?: AnchorRect
}

